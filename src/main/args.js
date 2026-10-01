'use strict';
/* Quote-aware argument tokenizer for the `app` action's Arguments field.
   Pure and dependency-free — tests/unit/args.test.js owns the spec.

   Rules (Windows-flavoured, deliberately simple — this feeds an argv array
   whose re-quoting Node handles by MSVCRT rules, which native apps parse
   back via CommandLineToArgvW):
     - whitespace runs split tokens outside quotes;
     - "..." groups into one token with the quote characters consumed
       (an attached group like --flag="a b" stays ONE token: --flag=a b);
     - an unclosed quote is lenient: the remainder of the input is the token;
     - "" alone yields one explicit empty token (some programs mean it);
     - at most MAX_TOKENS tokens; everything past the cap folds into the
       last one, so a pathological string can't fan out into a huge argv. */

const MAX_TOKENS = 64;

function splitArgs(input) {
  const s = typeof input === 'string' ? input : (input == null ? '' : String(input));
  const tokens = [];
  let cur = '';
  let has = false;              // saw any char of the current token ("" must yield '')
  let inQ = false;

  const push = () => {
    if (!has) return;
    if (tokens.length >= MAX_TOKENS) tokens[tokens.length - 1] += (tokens[tokens.length - 1] ? ' ' : '') + cur;
    else tokens.push(cur);
    cur = '';
    has = false;
  };

  for (const ch of s) {
    if (inQ) {
      if (ch === '"') { inQ = false; has = true; }   // closing quote consumed
      else { cur += ch; has = true; }
      continue;
    }
    if (ch === '"') { inQ = true; has = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
    has = true;
  }
  push();                     // unclosed quote: whatever is left is the token
  return tokens;
}

module.exports = { splitArgs, MAX_TOKENS };
