// agent-tools.js — High-level tools the LLM can call, plus the system prompt.
//
// These are intentionally coarse-grained "journeys". Each one fans out into
// several low-level MCP tool calls (and human-in-the-loop screens) handled by
// the orchestrator, keeping the LLM's job to deciding *when* to connect, list
// accounts, and top up — exactly how a partner app would model the BPI
// Fund Top-Up experience.

export const SYSTEM_PROMPT = `You are the AI assistant inside "DRAGONPAY CORP", a partner app that can move money using BPI Open Banking via an MCP (Model Context Protocol) connection to the BPI MCP Server.

You can help a customer load/top-up funds from their BPI deposit account. Available tools:
- connect_bpi_account: starts BPI 3-Legged OAuth (the customer logs in on the BPI page and approves). Call this first, before any account or payment action, unless already connected this session.
- list_bpi_accounts: fetches the customer's BPI accounts and lets them pick the source account.
- fund_topup: moves a given peso amount from the selected BPI account (requires the customer to approve with a transaction OTP).

Guidelines:
- For a top-up request, the natural sequence is: connect_bpi_account → list_bpi_accounts → fund_topup.
- Never ask the customer for their BPI password or OTP in chat — those are collected securely on the BPI screens by the tools.
- Confirm the amount before topping up if it is unclear. Keep replies short, friendly, and professional. Use the peso sign (₱).
- After a successful top-up, tell the customer the amount, the source account, and the confirmation number.`;

// JSON-schema tool declarations (compatible with @google/genai functionDeclarations).
export const TOOL_DECLARATIONS = [
  {
    name: 'connect_bpi_account',
    description: 'Start BPI 3-Legged OAuth so the customer can securely log in and grant access. Call before listing accounts or topping up. No-op if already connected.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'list_bpi_accounts',
    description: "Retrieve the customer's BPI transactional accounts and let them choose the source account for a top-up. Requires an active BPI connection.",
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'fund_topup',
    description: 'Top up / load a peso amount from the selected BPI account. The customer approves with a transaction OTP on a BPI screen.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: { type: 'NUMBER', description: 'Amount in PHP to top up, e.g. 500' },
        remarks: { type: 'STRING', description: 'Optional remarks/description for the transaction' },
      },
      required: ['amount'],
    },
  },
];

export const TOOL_NAMES = TOOL_DECLARATIONS.map((t) => t.name);
