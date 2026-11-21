'use client';

import { useState, useTransition } from 'react';
import { Hash } from 'lucide-react';
import { toast } from 'sonner';
import { setDiscordChannelAction } from '@/app/actions';
import { ResponsiveSheet } from '@/components/responsive-sheet';
import { Button } from '@/components/ui/button';
import { Card, Row } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import type { ChannelSetting, ChannelView } from '@/lib/discord/channel-setting';


/**
 * Discord channel (plan v4 section 2): the channel this project's posts and tracked messages are in, and the switch "Every post is an
 * issue". One row like Production: a summary and one Change button, a sheet for the picker and the switch. Set here only, never by an agent.
 */
export function DiscordChannelSetting({ projectId, view }: { projectId: string; view: ChannelView }) {
  const [setting, setSetting] = useState<ChannelSetting | null>(view.setting);
  const [open, setOpen] = useState(false);
  if (!view.server) return null; // the organization has no Discord server

  return (
    <div className="space-y-1.5" data-part="discord-channel">
      <h3 className="text-meta font-semibold text-foreground px-1 md:px-0">Discord channel</h3>
      <p className="text-meta text-muted-foreground px-1 md:px-0">Posts here become issues on this project, and a message marked with the track emoji in this channel belongs to it.</p>
      <Card>
        <Row
          data-discord-channel-row
          leading={<Hash className="size-4" />}
          title={<span data-discord-channel-summary>{setting ? `#${setting.name}` : 'None'}</span>}
          meta={setting ? (setting.everyPost ? 'Every post is an issue' : 'Tracked messages only') : 'No channel for this project'}
          trailing={
            <Button variant="ghost" size="touch" className="px-3 rounded-pill text-muted-foreground" onClick={() => setOpen(true)} data-discord-channel-change>
              Change
            </Button>
          }
        />
      </Card>
      {open && <ChannelSheet projectId={projectId} view={view} setting={setting} onSaved={s => { setSetting(s); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ChannelSheet({ projectId, view, setting, onSaved, onClose }: { projectId: string; view: ChannelView; setting: ChannelSetting | null; onSaved: (s: ChannelSetting | null) => void; onClose: () => void }) {
  const [channel, setChannel] = useState(setting?.channelId ?? '');
  const [every, setEvery] = useState(setting?.everyPost ?? true);
  const [pending, start] = useTransition();

  const save = (channelId: string | null) =>
    start(async () => {
      const r = await setDiscordChannelAction(projectId, channelId, every);
      if (!r.ok) return void toast.error(r.error);
      toast(r.data ? `Channel #${r.data.name} saved` : 'Channel removed');
      onSaved(r.data);
    });

  return (
    <ResponsiveSheet title="Discord channel" onClose={onClose}>
      <div className="space-y-3 pb-2" data-discord-channel-sheet>
        {!view.linked ? (
          <p className="text-meta text-muted-foreground">Connect your Discord in Settings › Notifications first: you pick from the channels your account can see.</p>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-meta font-semibold text-foreground">Channel</span>
              <Select className="h-11 md:h-9 w-full" value={channel} onChange={e => setChannel(e.target.value)} aria-label="Channel" data-discord-channel-pick>
                <option value="">None</option>
                {setting && !view.channels.some(c => c.id === setting.channelId) && <option value={setting.channelId}>#{setting.name}</option>}
                {view.channels.map(c => (
                  <option key={c.id} value={c.id} disabled={!!view.taken[c.id]}>
                    #{c.name}
                    {view.taken[c.id] ? ` (${view.taken[c.id]})` : ''}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 min-h-row text-body md:text-meta">
              <Checkbox checked={every} onCheckedChange={v => setEvery(v === true)} data-discord-channel-every aria-label="Every post is an issue" />
              Every post is an issue
            </label>
            <p className="text-meta text-muted-foreground">Each post from a person becomes a task here and the bot answers under it. The first time, posts from the last 7 days are recorded too.</p>
            <div className="flex gap-2">
              <Button variant="outline" size="touch" className="flex-1" onClick={() => save(null)} disabled={pending || !setting} data-discord-channel-remove>
                Remove
              </Button>
              <Button size="touch" className="flex-1" onClick={() => save(channel || null)} disabled={pending} data-discord-channel-save>
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </ResponsiveSheet>
  );
}
