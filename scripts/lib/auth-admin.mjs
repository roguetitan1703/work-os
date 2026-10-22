// A Better Auth instance for scripts (scripts/migrate-auth.mjs) and the e2e seed (tests/e2e): creates users,
// organizations, memberships and API keys through Better Auth's own adapter and hasher, so they are stored exactly as
// the app stores them. Never served over HTTP.
//
// Keep the options that decide what is stored the same as lib/auth-server.ts: the organization plugin's invitation
// field, the API key prefix, length and metadata, the cookie prefix. Plugins that only add endpoints are left out.
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { organization } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { ObjectId } from 'mongodb';

export const API_KEY_PREFIX = 'wos_';

const idIn = id => ({ $in: ObjectId.isValid(id) && String(id).length === 24 ? [new ObjectId(id), String(id)] : [String(id)] });

/** db, client: a connected MongoClient's Db and the client. secret: 32+ characters (only used for hashing context). */
export function authAdmin({ db, client, secret, baseURL = 'http://localhost' }) {
  const auth = betterAuth({
    baseURL,
    basePath: '/api/auth',
    secret,
    database: mongodbAdapter(db, { client }),
    telemetry: { enabled: false },
    logger: { level: 'error' },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10, maxPasswordLength: 256 },
    advanced: { cookiePrefix: 'workos' },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        schema: { invitation: { additionalFields: { tokenHash: { type: 'string', required: false, input: false } } } },
      }),
      apiKey({ defaultPrefix: API_KEY_PREFIX, defaultKeyLength: 48, enableMetadata: true, requireName: true, maximumNameLength: 60, rateLimit: { enabled: false } }),
    ],
  });

  return {
    auth,
    async findUser(email) {
      const ctx = await auth.$context;
      return ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase()).then(r => r?.user ?? null);
    },
    /** Creates a user; with a password also their email+password login. Returns the user id. */
    async createUser({ email, name, password }) {
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.createUser({ email: email.trim().toLowerCase(), name, emailVerified: true }, { method: 'email-password' });
      if (password) await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(password) });
      return String(user.id);
    },
    async findOrg(slug) {
      const o = await db.collection('organization').findOne({ slug });
      return o ? { id: String(o._id), name: o.name, slug: o.slug } : null;
    },
    /** Creates an organization (no member yet). Returns its id. */
    async createOrg({ name, slug }) {
      const ctx = await auth.$context;
      const o = await ctx.adapter.create({ model: 'organization', data: { name, slug, createdAt: new Date() } });
      return String(o.id);
    },
    async memberRole(userId, orgId) {
      const m = await db.collection('member').findOne({ userId: idIn(userId), organizationId: idIn(orgId) });
      return m ? m.role : null;
    },
    async addMember({ userId, orgId, role }) {
      const ctx = await auth.$context;
      await ctx.adapter.create({ model: 'member', data: { organizationId: orgId, userId, role, createdAt: new Date() } });
    },
    /** A Work OS API key for userId in orgId; agent 'claude' or 'claude-code'; expiresIn in seconds (optional). Returns { key, id }. */
    async createKey({ userId, orgId, agent, name, expiresIn }) {
      const k = await auth.api.createApiKey({ body: { name, userId, metadata: { agent, orgId }, ...(expiresIn ? { expiresIn } : {}) } });
      return { key: k.key, id: String(k.id) };
    },
  };
}
