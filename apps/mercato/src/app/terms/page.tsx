import { redirect } from 'next/navigation';

/* Noli's Terms and Privacy Policy live in one place, noliai.com, for every
 * product. This route used to serve a stale copy written for a different
 * brand; it now sends the reader to the current document. */
export default function Page() {
  redirect('https://noliai.com/terms');
}
