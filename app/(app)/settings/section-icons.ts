import { Bell, Cable, ListChecks, Plug, Server, UserRound, Users, type LucideIcon } from 'lucide-react';
import type { SectionId } from './sections';

export const SECTION_ICON: Record<SectionId, LucideIcon> = { account: UserRound, notifications: Bell, connections: Plug, 'ai-tools': Cable, started: ListChecks, team: Users, server: Server };
