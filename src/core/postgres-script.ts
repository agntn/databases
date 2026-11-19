/**
 * Finds a BEGIN or COMMIT in a Postgres script, which has no authorizer to ask. Reads past
 * comments, quotes, dollar quotes and `BEGIN ATOMIC` bodies; a `DO` block Postgres guards itself.
 */

/** First words that open or end a transaction. `ROLLBACK TO` only rewinds to a savepoint. */
const CONTROL = new Set(["abort", "begin", "commit", "end", "rollback", "start"]);

const WORD = /[A-Za-z_][\w$]*/uy;

const DOLLAR = /\$(?:[A-Za-z_]\w*)?\$/uy;

const LINE_END = /[\n\r]/gu;

/** What `CREATE [OR REPLACE]` makes when a `BEGIN ATOMIC` body may follow. */
const ROUTINE = new Set(["function", "procedure"]);

/** Reads a Postgres script one token at a time. */
class ScriptReader {
  readonly #sql: string;
  #at = 0;
  /** Lower-case words of the statement read so far, the first two only. */
  #words: string[] = [];
  /** The statement creates a function or procedure, the only place `BEGIN ATOMIC` opens a body. */
  #routine = false;
  /** Open `BEGIN ATOMIC` and `CASE`, where `;` ends nothing. */
  #depth = 0;
  #last = "";

  constructor(sql: string) {
    this.#sql = sql;
  }

  /**
   * The first transaction control statement, or nothing.
   *
   * @returns {string | undefined} Its first words, such as `commit`.
   */
  find(): string | undefined {
    while (this.#at < this.#sql.length) {
      const char = this.#sql[this.#at] ?? "";
      if (char === ";" && this.#depth === 0) {
        const found = this.#verdict();
        if (found !== undefined) return found;
        this.#words = [];
        this.#routine = false;
        this.#at += 1;
      } else if (!this.#skipQuoted(char)) this.#token(char);
    }
    return this.#verdict();
  }

  /**
   * Reads a word or one character of anything else.
   *
   * @param char - The character at the cursor.
   */
  #token(char: string): void {
    WORD.lastIndex = this.#at;
    const word = WORD.exec(this.#sql)?.[0];
    if (word === undefined) {
      this.#at += 1;
      if (!/\s/u.test(char)) this.#note("");
      return;
    }
    this.#at += word.length;
    this.#note(word.toLowerCase());
  }

  /**
   * Remembers a word, and keeps count of the bodies a `;` doesn't end.
   *
   * @param word - Lower case, or `""` for punctuation and quoted text.
   */
  #note(word: string): void {
    if (this.#words[0] === "create" && ROUTINE.has(word)) this.#routine = true;
    this.#nest(word);
    if (this.#words.length < 2) this.#words.push(word);
    this.#last = word;
  }

  /**
   * Opens or closes a routine body or a `CASE` inside one.
   *
   * @param word - Lower case.
   */
  #nest(word: string): void {
    if (word === "atomic" && this.#last === "begin" && this.#routine) this.#depth += 1;
    else if (this.#depth > 0 && word === "case") this.#depth += 1;
    else if (this.#depth > 0 && word === "end") this.#depth -= 1;
  }

  /**
   * Whether the statement read so far opens or ends a transaction.
   *
   * @returns {string | undefined} Its first words, when it does.
   */
  #verdict(): string | undefined {
    const [first, second] = this.#words;
    if (first === undefined || !CONTROL.has(first)) return undefined;
    if (first === "rollback" && second === "to") return undefined;
    return this.#words.filter(Boolean).join(" ");
  }

  /**
   * Steps over a comment or anything quoted that starts here.
   *
   * @param char - The character at the cursor.
   * @returns {boolean} Whether something was skipped.
   */
  #skipQuoted(char: string): boolean {
    const next = this.#sql[this.#at + 1] ?? "";
    if (char === "-" && next === "-") return this.#skipLine();
    if (char === "/" && next === "*") return this.#skipComment();
    if (char === "'") return this.#skipQuote("'", this.#escapes());
    if (char === '"') return this.#skipQuote('"', false);
    return char === "$" && this.#skipDollar();
  }

  /**
   * Whether the string about to start is `E'...'`, where a backslash escapes the next character.
   *
   * @returns {boolean} The prefix is a lone E.
   */
  #escapes(): boolean {
    return /(?:^|[^\w$])[Ee]$/u.test(this.#sql.slice(Math.max(0, this.#at - 2), this.#at));
  }

  /**
   * Moves past the next `end`, or to the end of the script.
   *
   * @param end - What closes it.
   * @param from - Characters to skip before looking.
   * @returns {true} Always; something was skipped.
   */
  #skipPast(end: string, from: number): true {
    const close = this.#sql.indexOf(end, this.#at + from);
    this.#at = close < 0 ? this.#sql.length : close + end.length;
    return true;
  }

  /**
   * Moves past a `--` comment, which Postgres ends at CR or LF.
   *
   * @returns {true} Always.
   */
  #skipLine(): true {
    LINE_END.lastIndex = this.#at;
    this.#at = LINE_END.exec(this.#sql) === null ? this.#sql.length : LINE_END.lastIndex;
    return true;
  }

  /**
   * Moves past a block comment, which nests in Postgres.
   *
   * @returns {true} Always.
   */
  #skipComment(): true {
    let depth = 0;
    do {
      const pair = this.#sql.slice(this.#at, this.#at + 2);
      if (pair === "/*") depth += 1;
      else if (pair === "*/") depth -= 1;
      this.#at += pair === "/*" || pair === "*/" ? 2 : 1;
    } while (depth > 0 && this.#at < this.#sql.length);
    return true;
  }

  /**
   * Moves past `'...'` or `"..."`, where a doubled quote stays inside.
   *
   * @param quote - The quote character.
   * @param backslash - A backslash escapes the next character, as in `E'...'`.
   * @returns {true} Always.
   */
  #skipQuote(quote: string, backslash: boolean): true {
    this.#at += 1;
    while (this.#at < this.#sql.length) {
      const char = this.#sql[this.#at];
      this.#at += backslash && char === "\\" ? 2 : 1;
      if (char === quote && this.#sql[this.#at] !== quote) break;
      if (char === quote) this.#at += 1;
    }
    this.#note("");
    return true;
  }

  /**
   * Moves past `$tag$...$tag$`. `$1` is a parameter, not a quote.
   *
   * @returns {boolean} Whether a dollar quote started here.
   */
  #skipDollar(): boolean {
    DOLLAR.lastIndex = this.#at;
    const tag = DOLLAR.exec(this.#sql)?.[0];
    if (tag === undefined) return false;
    this.#skipPast(tag, tag.length);
    this.#note("");
    return true;
  }
}

/**
 * The first statement of a Postgres script that opens or ends a transaction.
 *
 * @param sql - The script.
 * @returns {string | undefined} Its first words in lower case, such as `commit`, or nothing.
 */
export function transactionControl(sql: string): string | undefined {
  return new ScriptReader(sql).find();
}
