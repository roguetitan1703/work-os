// The operator runs this Work OS deployment (Om). Some things are about the deployment rather than any one
// organization: the health report, registering Discord commands, the request log (Settings › Usage), and, until
// phase 3 gives each person their own, the built-in schedule. Those go to the operator only, by email:
//   OPERATOR_EMAILS=om@example.com,second@example.com
// An organization's owner or admin is not an operator unless listed. Unset: nobody is.

export function operatorEmails(): string[] {
  return (process.env.OPERATOR_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOperator(who: { email?: string | null } | null | undefined): boolean {
  const e = who?.email?.trim().toLowerCase();
  return !!e && operatorEmails().includes(e);
}
