// Where seed.mjs leaves the seeded team (ids and throwaway keys), beside the e2e state file in the run's temp folder.
import fs from 'node:fs';
import path from 'node:path';

export const TEAM_FILE = path.join(path.dirname(process.env.E2E_STATE || '.'), 'team.json');
export const loadTeam = () => JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8'));
