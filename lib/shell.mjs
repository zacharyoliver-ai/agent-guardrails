/**
 * Splits a shell line into simple commands, each an array of words with
 * quotes removed. Separators are && || ; | & newlines, parentheses and
 * backticks. Heredoc bodies and comments are dropped, and leading VAR=value
 * assignments are stripped. This is a tokenizer, not a shell: it never
 * expands anything, it only keeps quoted text from looking like a command.
 */
export function simpleCommands(line) {
  const src = String(line ?? '');
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const heredocs = []; // delimiters waiting for the next newline

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i < words.length) commands.push(words.slice(i));
    words = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] === '\n') i++; // line continuation
      else if (i + 1 < src.length) {
        word += src[++i];
        inWord = true;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      word += src.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && '$`"\\\n'.includes(src[i + 1] ?? 'x')) {
          if (src[i + 1] !== '\n') word += src[i + 1];
          i++;
        } else word += src[i];
      }
    } else if (c === '\n') {
      endCommand();
      while (heredocs.length) {
        const delim = heredocs.shift();
        let pos = i + 1;
        while (pos < src.length) {
          let eol = src.indexOf('\n', pos);
          if (eol === -1) eol = src.length;
          const text = src.slice(pos, eol).replace(/\r$/, '');
          pos = eol + 1;
          if (text.trim() === delim) break;
        }
        i = pos - 2; // loop increment lands on the start of the next line
      }
    } else if (c === '#' && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' && src[i - 1] !== '<') {
      let j = i + 2;
      if (src[j] === '-') j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const m = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(src.slice(j));
      if (m) {
        heredocs.push(m[1] ?? m[2] ?? m[3]);
        endWord();
        i = j + m[0].length - 1;
      } else {
        word += c;
        inWord = true;
      }
    } else if (c === '&' || c === '|') {
      if (src[i + 1] === c) i++;
      endCommand();
    } else if (c === ';' || c === '(' || c === ')' || c === '`') {
      endCommand();
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}
