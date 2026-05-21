/**
 * Shared glob → RegExp compiler.
 *
 * Used by find_files (filesystem walk) and list_indexed_files (index query)
 * so both honour identical pattern semantics. Patterns are matched against
 * POSIX-normalised paths (forward slashes) — callers are responsible for
 * normalising before testing.
 *
 * Supports:
 *   *       any chars within a path segment (no '/')
 *   **      any chars including '/'
 *   ?       single char (no '/')
 *   [abc]   char class (passed through to regex)
 *   {a,b}   alternation
 */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1; // **/ → eat the slash too
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
      } else {
        const alts = pattern.slice(i + 1, end).split(",").map(escapeRegex).join("|");
        re += `(?:${alts})`;
        i = end + 1;
      }
    } else if ("/\\.+^$()|".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** POSIX-normalise a path so glob matching is OS-independent. */
export function toPosixPath(p: string, sep: string): string {
  return sep === "\\" ? p.replace(/\\/g, "/") : p;
}
