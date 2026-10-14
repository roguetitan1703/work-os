import { redirect } from 'next/navigation';

/** Archive lives in History. Send the phone (and anyone else) straight to that tab. */
export default function ArchivePage() {
  redirect('/history?tab=archived');
}
