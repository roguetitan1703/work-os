import { loginAction } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

export const metadata = { title: 'Sign in · Work OS' };

export default async function LoginPage({ searchParams }: Props) {
  const { error, next } = await searchParams;
  return (
    <div className="min-h-full w-full flex items-center justify-center p-6">
      <form action={loginAction} className="w-full max-w-xs space-y-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Work OS</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Sign in to continue.</p>
        </div>
        <input type="hidden" name="next" value={next ?? '/today'} />
        <Input name="password" type="password" placeholder="Password" autoFocus required autoComplete="current-password" />
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {error === 'config' ? 'Auth is not configured on the server.' : 'Wrong password.'}
          </p>
        )}
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}
