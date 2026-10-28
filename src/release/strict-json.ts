// A JSON parser that rejects duplicate object keys and keeps number text, so 1 and 1.0 stay distinguishable.
export type StrictJson = string | boolean | null | { number: string } | StrictJson[] | Map<string, StrictJson>;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|NaN|-?Infinity/uy;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy;
const SPACE = /[ \t\n\r]*/uy;

export class StrictJsonError extends Error {}

export function parseStrictJson(text: string, onDuplicate: () => never): StrictJson {
  let position = 0;
  const skip = () => { SPACE.lastIndex = position; SPACE.test(text); position = SPACE.lastIndex; };
  const match = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = position;
    const found = pattern.exec(text)?.[0];
    if (found !== undefined) position += found.length;
    return found;
  };
  const value = (): StrictJson => {
    skip();
    const char = text[position];
    if (char === "{") {
      position += 1;
      const result = new Map<string, StrictJson>();
      skip();
      if (text[position] === "}") { position += 1; return result; }
      for (;;) {
        skip();
        const key = match(STRING);
        if (key === undefined) throw new StrictJsonError("expected a string key");
        skip();
        if (text[position++] !== ":") throw new StrictJsonError("expected a colon");
        const name = JSON.parse(key) as string;
        if (result.has(name)) onDuplicate();
        result.set(name, value());
        skip();
        const next = text[position++];
        if (next === "}") return result;
        if (next !== ",") throw new StrictJsonError("expected a comma");
      }
    }
    if (char === "[") {
      position += 1;
      const result: StrictJson[] = [];
      skip();
      if (text[position] === "]") { position += 1; return result; }
      for (;;) {
        result.push(value());
        skip();
        const next = text[position++];
        if (next === "]") return result;
        if (next !== ",") throw new StrictJsonError("expected a comma");
      }
    }
    const string = match(STRING);
    if (string !== undefined) return JSON.parse(string) as string;
    for (const [word, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, position)) { position += word.length; return parsed; }
    }
    const number = match(NUMBER);
    if (number !== undefined) return { number };
    throw new StrictJsonError("unexpected token");
  };
  const result = value();
  skip();
  if (position !== text.length) throw new StrictJsonError("unexpected trailing data");
  return result;
}
