/**
 * Decodes common backslash escapes (\n, \r, \t, \0, \xNN) found in YAML-defined
 * banners and handlers, so binary-ish protocol responses can be written as
 * readable strings in honeyprompt.yaml.
 */
export function decodeEscapes(input: string): string {
  return input.replace(/\\(x[0-9a-fA-F]{2}|[nrt0\\])/g, (_m, seq: string) => {
    switch (seq) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      default:
        return String.fromCharCode(parseInt(seq.slice(1), 16));
    }
  });
}
