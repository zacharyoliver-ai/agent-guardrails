/**
 * Splits a shell line into simple commands, each an array of words with
 * quotes removed. Separators are && || ; | & newlines, parentheses and
 * backticks. Heredoc bodies, comments and output redirections are dropped, and
 * leading VAR=value assignments are stripped. Input redirections stay, because
 * the guards read them. This is a tokenizer, not a shell: it never expands
 * anything, it only keeps quoted text from looking like a command.
 */
export function simpleCommands(line) {
  const commands = [];
  scan(String(line ?? ''), 0, false, commands);
  return commands;
}

/** A command's words without its input redirections, for a guard that reads arguments: `<file`, or `<` and then file. */
export function withoutInput(words) {
  return words.filter((w, i) => !w.startsWith('<') && words[i - 1] !== '<');
}

/**
 * Scans src from start and appends simple commands to `commands`. A $( ... ) or
 * a backtick pair inside double quotes is scanned by a nested call, so its
 * contents are commands in their own right and its quotes and heredocs cannot
 * unbalance the outer quote. With inSub set, returns the index of the ")" that
 * closes the substitution.
 */
function scan(src, start, inSub, commands) {
  let depth = 0;
  let words = [];
  let word = '';
  let inWord = false;
  let dropNext = false; // the next word is the target of an output redirection
  const heredocs = []; // delimiters waiting for the next newline

  const endWord = () => {
    if (inWord) {
      if (!dropNext) words.push(word);
      dropNext = false;
    }
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    dropNext = false;
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i < words.length) commands.push(words.slice(i));
    words = [];
  };

  for (let i = start; i < src.length; i++) {
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
        if (src[i] === '$' && src[i + 1] === '(') i = scan(src, i + 2, true, commands);
        else if (src[i] === '`') {
          const end = src.indexOf('`', i + 1);
          const stop = end === -1 ? src.length : end;
          scan(src.slice(i + 1, stop), 0, false, commands);
          i = stop;
        } else if (src[i] === '\\' && '$`"\\\n'.includes(src[i + 1] ?? 'x')) {
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
    } else if (c === '>' || (c === '&' && src[i + 1] === '>')) {
      // An output redirection and its target are not arguments: 2>&1, > out.txt, &>> log.
      if (/^(?:\d+|\*)$/.test(word)) {
        word = '';
        inWord = false;
      } else endWord();
      i += /^&?>{1,2}[&|]?/.exec(src.slice(i))[0].length - 1;
      dropNext = true;
    } else if (c === '&' || c === '|') {
      if (src[i + 1] === c) i++;
      endCommand();
    } else if (c === '(' && inSub) {
      depth++;
      endCommand();
    } else if (c === ')' && inSub) {
      endCommand();
      if (depth === 0) return i;
      depth--;
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
  return src.length;
}
