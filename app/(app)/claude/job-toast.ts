import { toast } from 'sonner';
import { jobOutcomeAction } from '../projects/[id]/launcher-actions';

/** After a job was queued for a computer: poll its result for up to a minute and toast how it went. */
export async function trackJob(jobId: string, doing: string, done: string): Promise<void> {
  const id = toast.loading(doing);
  try {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, i < 3 ? 1500 : 2500));
      const r = await jobOutcomeAction(jobId);
      if (!r.ok) return void toast.error(r.error, { id });
      if (!r.data.done) continue;
      if (r.data.ok) return void toast.success(done, { id });
      return void toast.error(r.data.error ?? 'Failed', { id });
    }
    toast("Still waiting for that PC; it may be off or its worker stopped.", { id });
  } catch {
    toast.error('Something went wrong', { id });
  }
}
