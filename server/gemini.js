// gemini.js — Thin wrapper over @google/genai exposing a uniform `next()` call.
import { GoogleGenAI } from '@google/genai';

export function createGeminiLLM({ apiKey, model = 'gemini-2.0-flash', tools, system }) {
  const ai = new GoogleGenAI({ apiKey });
  return {
    name: `Gemini (${model})`,
    /**
     * @param {Array} contents Gemini-format conversation contents.
     * @returns {Promise<{text:string, calls:Array<{name:string,args:object}>}>}
     */
    async next(contents) {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: system,
          temperature: 0.2,
          tools: [{ functionDeclarations: tools }],
        },
      });
      const calls = (res.functionCalls || []).map((c) => ({ name: c.name, args: c.args || {} }));
      let text = '';
      try { text = res.text || ''; } catch { text = ''; }
      return { text, calls };
    },
  };
}
