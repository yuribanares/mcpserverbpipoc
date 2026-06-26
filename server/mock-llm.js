// mock-llm.js — Offline fallback "LLM" so the PoC runs with no Gemini API key.
//
// It is not a real model: it pattern-matches the customer's first message to
// detect a top-up intent and then walks the same connect → list → fund_topup
// tool sequence the real model would, using the same `next(contents)` contract
// as gemini.js. This keeps the four-panel demo fully functional out of the box.

const INTENT = /(top\s*-?up|load|fund|wallet|cash\s*in|add\s+money|reload|transfer|send|pay)/i;

export function createMockLLM() {
  return {
    name: 'Scripted demo planner (no API key)',
    async next(contents) {
      const firstUser = contents.find((c) => c.role === 'user' && c.parts?.some((p) => p.text));
      const userText = firstUser?.parts?.map((p) => p.text).filter(Boolean).join(' ') || '';

      const called = toolsCalled(contents);
      const amount = parseAmount(userText);

      if (!INTENT.test(userText) && called.length === 0) {
        return {
          text: "Hi! I'm your DRAGONPAY assistant. I can load funds into your wallet straight from your BPI account. " +
            'Try: “Load ₱500 to my wallet from my BPI account.”',
          calls: [],
        };
      }

      if (!called.includes('connect_bpi_account')) {
        return { text: "Sure — let's connect your BPI account first. Opening the secure BPI login…", calls: [{ name: 'connect_bpi_account', args: {} }] };
      }
      if (!called.includes('list_bpi_accounts')) {
        return { text: 'Connected. Please choose which BPI account to use as the source.', calls: [{ name: 'list_bpi_accounts', args: {} }] };
      }
      if (!called.includes('fund_topup')) {
        return { text: `Got it. Topping up ₱${amount.toLocaleString()} now — please approve with the OTP sent to your phone.`, calls: [{ name: 'fund_topup', args: { amount, remarks: 'Load funds to wallet' } }] };
      }

      // All steps done — summarize from the last fund_topup response.
      const result = lastToolResponse(contents, 'fund_topup');
      if (result?.confirmationNumber) {
        return {
          text: `✅ Done! ₱${amount.toLocaleString()} was loaded from your ${result.sourceAccount || 'BPI account'}.\n` +
            `Confirmation no. ${result.confirmationNumber} (${result.confirmationTimestamp || 'just now'}).\n` +
            'Anything else I can help you with?',
          calls: [],
        };
      }
      return { text: 'Your top-up has been submitted. Is there anything else I can help you with?', calls: [] };
    },
  };
}

function toolsCalled(contents) {
  const names = [];
  for (const c of contents) {
    if (c.role === 'model') {
      for (const p of c.parts || []) if (p.functionCall) names.push(p.functionCall.name);
    }
  }
  return names;
}

function lastToolResponse(contents, name) {
  for (let i = contents.length - 1; i >= 0; i--) {
    for (const p of contents[i].parts || []) {
      if (p.functionResponse?.name === name) return p.functionResponse.response;
    }
  }
  return null;
}

function parseAmount(text) {
  const m = text.replace(/,/g, '').match(/(?:₱|php|peso[s]?\s*)?\s*(\d+(?:\.\d+)?)/i);
  const n = m ? Number(m[1]) : 500;
  return Number.isFinite(n) && n > 0 ? n : 500;
}
