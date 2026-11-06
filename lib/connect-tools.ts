// Settings › AI tools: how to connect other AI tools to this Work OS's MCP server (docs/connect.md).
// Every snippet below was taken from the tool's own official docs on CHECKED, with this server's address filled in.
// `tested` says whether anyone connected that tool to a Work OS server; the screen shows it, never hides it.

export const CHECKED = '2026-11-06';

export type Snippet = { label: string; text: string; /** Where to run or save it. */ where: string };
export type Tool = {
  id: 'claude-code' | 'cursor' | 'antigravity' | 'chatgpt';
  name: string;
  /** What was actually tried. */
  tested: { done: boolean; note: string };
  /** One plain sentence on how it signs in. */
  signIn: string;
  steps: string[];
  snippets: Snippet[];
  /** A plain warning shown above the steps (availability). */
  warning?: string;
  docs: { label: string; href: string };
};

/** `mcpUrl` is this server's MCP address (APP_URL + /api/mcp), exactly what a tool must be given. */
export function tools(mcpUrl: string): Tool[] {
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      tested: { done: true, note: 'Tested with the Claude Code CLI 2.1.310: added with the command below and listed as connected (signed in with a key). The browser sign-in step was not run through the CLI.' },
      signIn: 'Signs in with your Work OS account in the browser (OAuth). No key to copy.',
      steps: ['Run the command in any terminal.', 'In Claude Code type /mcp, pick work-os, then Authenticate. Your browser opens the Work OS Allow screen.'],
      snippets: [
        { label: 'Add the server', where: 'Terminal', text: `claude mcp add --scope user --transport http work-os ${mcpUrl}` },
        { label: 'Or share it with a project (.mcp.json in the project folder)', where: '.mcp.json', text: json({ mcpServers: { 'work-os': { type: 'http', url: mcpUrl } } }) },
        { label: 'If you cannot sign in: use a key (Claude › Setup › Claude Code key)', where: 'Terminal', text: `claude mcp add --scope user --transport http work-os ${mcpUrl} --header "Authorization: Bearer YOUR_KEY"` },
      ],
      docs: { label: 'Claude Code: connect to MCP servers', href: 'https://code.claude.com/docs/en/mcp' },
    },
    {
      id: 'cursor',
      name: 'Cursor',
      tested: { done: false, note: 'Not tested yet. Cursor is installed on the PC this was built on, but signing in needs its window and could not be driven there.' },
      signIn: 'Cursor signs in with OAuth when the server asks for it (it registers itself, like Claude does).',
      steps: ['Put the snippet in ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).', 'Reload Cursor. Its MCP settings should list work-os; sign in there when it asks (Cursor’s docs describe an OAuth sign-in for servers that ask for one).'],
      snippets: [{ label: 'mcp.json', where: '~/.cursor/mcp.json', text: json({ mcpServers: { 'work-os': { url: mcpUrl } } }) }],
      docs: { label: 'Cursor: Model Context Protocol', href: 'https://cursor.com/docs/context/mcp' },
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      tested: { done: false, note: 'Not tested yet. Antigravity is not installed on the PC this was built on.' },
      signIn: 'Antigravity handles OAuth 2.0 by itself for servers that support dynamic registration, which Work OS does.',
      steps: [
        'In the Antigravity app: Customizations › Installed › MCP Servers › Copy Config File Path, then open that file. (Its docs name ~/.gemini/config/mcp_config.json for all projects, or .agents/mcp_config.json in a workspace; an older guide says ~/.gemini/antigravity/mcp_config.json, so trust the path the app gives you.)',
        'Add the snippet and save. Then sign in from the same MCP Servers list.',
      ],
      snippets: [{ label: 'mcp_config.json', where: 'mcp_config.json', text: json({ mcpServers: { 'work-os': { serverUrl: mcpUrl } } }) }],
      docs: { label: 'Antigravity: MCP', href: 'https://antigravity.google/docs/mcp' },
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      tested: { done: false, note: 'Not tested yet. We could not open OpenAI’s help page directly, so the plan details below come from search summaries of it and may be out of date.' },
      signIn: 'ChatGPT adds MCP servers as a custom app in developer mode, in the ChatGPT website (not a config file).',
      warning:
        'ChatGPT may not let you add this on a personal account. As we read OpenAI’s help article, full custom MCP servers are for Business, Enterprise and Edu workspaces (an admin turns developer mode on); Pro can only connect read-only ones; for Plus and Free we could not confirm it. If the option is missing for you, that is ChatGPT, not Work OS.',
      steps: ['Follow OpenAI’s page below to turn on developer mode and create a custom app (the menu names change; we did not copy them).', 'Give it the address below as the server URL and choose OAuth sign-in. Allow it on the Work OS screen that opens.'],
      snippets: [{ label: 'Server URL', where: 'ChatGPT app form', text: mcpUrl }],
      docs: { label: 'OpenAI: developer mode and MCP apps in ChatGPT', href: 'https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt' },
    },
  ];
}
