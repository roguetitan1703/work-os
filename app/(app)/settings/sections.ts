// The Settings sections, grouped by who they are for (Claude's own Settings is laid out the same way: a left list with
// muted group labels). Shared by the page (server) and the left list (client).

export type SectionId = 'account' | 'notifications' | 'connections' | 'started' | 'team' | 'server';
export type GroupId = 'You' | 'Team' | 'Server';

export type SectionDef = { id: SectionId; label: string; group: GroupId; /** What the search box also matches. */ keywords: string; /** One plain line for the phone list. */ about: string };

export const SECTIONS: SectionDef[] = [
  { id: 'account', label: 'Account', group: 'You', keywords: 'theme dark light appearance password passkey authenticator security sign out email test', about: 'Theme, password, passkeys, sign out' },
  { id: 'notifications', label: 'Notifications', group: 'You', keywords: 'alerts phone push install app discord link quiet hours timezone send test devices', about: 'Alerts on your phone, quiet hours, Discord' },
  { id: 'connections', label: 'Connections', group: 'You', keywords: 'claude discord computers pc connect status', about: 'Claude, Discord and your computers' },
  { id: 'started', label: 'Get started', group: 'You', keywords: 'checklist first steps setup welcome hide', about: 'The first steps, ticked as you go' },
  { id: 'team', label: 'Team', group: 'Team', keywords: 'members invite roles owner admin people kinds of work modes', about: 'People, roles and invitations' },
  { id: 'server', label: 'Server', group: 'Server', keywords: 'health status usage requests discord server blocked channels sensitive scheduled checks push email', about: 'Health, usage and Discord on the server' },
];

/** Old ?section= values, and where they live now. `open` is passed along (Team opens the kinds-of-work list). */
export const LEGACY: Record<string, { to: SectionId; open?: string }> = {
  device: { to: 'notifications' },
  alerts: { to: 'notifications' },
  security: { to: 'account' },
  members: { to: 'team' },
  usage: { to: 'server' },
  help: { to: 'team', open: 'modes' },
};

export const sectionIn = (v: string | undefined): SectionId | null => SECTIONS.find(s => s.id === v)?.id ?? null;
