const ASCII_IDENTIFIER = /[A-Za-z0-9_$]/u;
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

function isEscapeStringPrefix(source, quoteIndex) {
  if (quoteIndex === 0 || !/[Ee]/u.test(source[quoteIndex - 1])) return false;
  return quoteIndex === 1 || !ASCII_IDENTIFIER.test(source[quoteIndex - 2]);
}

function unterminated(kind, offset) {
  throw new SyntaxError(
    `Unterminated PostgreSQL ${kind} starting at UTF-16 code-unit offset ${offset}.`,
  );
}

function lexicalSegments(source) {
  if (typeof source !== "string") {
    throw new TypeError("PostgreSQL source must be a string.");
  }

  const segments = [];
  let codeStart = 0;
  let index = 0;
  const pushCode = (end) => {
    if (end > codeStart) segments.push({ kind: "code", start: codeStart, end });
  };

  while (index < source.length) {
    if (source.startsWith("--", index)) {
      pushCode(index);
      const start = index;
      index += 2;
      while (
        index < source.length
        && source[index] !== "\r"
        && source[index] !== "\n"
      ) {
        index += 1;
      }
      segments.push({ kind: "comment", start, end: index });
      codeStart = index;
      continue;
    }

    if (source.startsWith("/*", index)) {
      pushCode(index);
      const start = index;
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) unterminated("block comment", start);
      segments.push({ kind: "comment", start, end: index });
      codeStart = index;
      continue;
    }

    if (source[index] === "'") {
      const escapeString = isEscapeStringPrefix(source, index);
      const start = escapeString ? index - 1 : index;
      pushCode(start);
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (escapeString && source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) unterminated("string literal", start);
      segments.push({ kind: "quoted", start, end: index });
      codeStart = index;
      continue;
    }

    if (source[index] === '"') {
      pushCode(index);
      const start = index;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) unterminated("quoted identifier", start);
      segments.push({ kind: "quoted", start, end: index });
      codeStart = index;
      continue;
    }

    if (source[index] === "$") {
      const delimiter = DOLLAR_QUOTE.exec(source.slice(index))?.[0];
      if (delimiter) {
        pushCode(index);
        const start = index;
        const closing = source.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) unterminated("dollar-quoted literal", start);
        index = closing + delimiter.length;
        segments.push({ kind: "quoted", start, end: index });
        codeStart = index;
        continue;
      }
    }

    index += 1;
  }

  pushCode(source.length);
  return segments;
}

function rangeHasStatementContent(source, segments, start, end) {
  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) continue;
    if (segment.kind === "quoted") return true;
    if (segment.kind === "comment") continue;
    const slice = source.slice(
      Math.max(start, segment.start),
      Math.min(end, segment.end),
    );
    if (/[^\s;]/u.test(slice)) return true;
  }
  return false;
}

export function splitPostgresStatements(source) {
  const segments = lexicalSegments(source);
  const semicolons = [];
  for (const segment of segments) {
    if (segment.kind !== "code") continue;
    for (let index = segment.start; index < segment.end; index += 1) {
      if (source[index] === ";") semicolons.push(index);
    }
  }

  const statements = [];
  let start = 0;
  for (const semicolon of semicolons) {
    const end = semicolon + 1;
    if (rangeHasStatementContent(source, segments, start, end)) {
      statements.push(Object.freeze({
        start,
        end,
        sql: source.slice(start, end),
      }));
    }
    start = end;
  }
  if (
    start < source.length
    && rangeHasStatementContent(source, segments, start, source.length)
  ) {
    statements.push(Object.freeze({
      start,
      end: source.length,
      sql: source.slice(start),
    }));
  }
  return Object.freeze(statements);
}

export function canonicalizePostgresStatement(statement) {
  const segments = lexicalSegments(statement);
  let canonical = "";
  let separatorPending = false;

  const appendSeparator = () => {
    if (separatorPending && canonical.length > 0) canonical += " ";
    separatorPending = false;
  };

  for (const segment of segments) {
    if (segment.kind === "comment") {
      separatorPending = true;
      continue;
    }
    if (segment.kind === "quoted") {
      appendSeparator();
      canonical += statement.slice(segment.start, segment.end);
      continue;
    }

    for (let index = segment.start; index < segment.end; index += 1) {
      const character = statement[index];
      if (/\s/u.test(character)) {
        separatorPending = true;
        continue;
      }
      appendSeparator();
      canonical += /[A-Z]/u.test(character)
        ? character.toLowerCase()
        : character;
    }
  }

  return canonical;
}
