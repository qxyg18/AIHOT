// Minimal declarations for the nameplate generator (yn255). opentype.js ships no types and is
// deliberately not a dependency (the script reads a packed font package passed on the command
// line), so only the four calls scripts/nameplates.ts makes are declared here.
declare module "opentype.js" {
  export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }

  export interface Path {
    getBoundingBox(): BoundingBox;
    toPathData(decimalPlaces?: number): string;
  }

  export class Font {
    constructor(options?: unknown);
    getPath(text: string, x: number, y: number, fontSize: number): Path;
  }

  export function parse(buffer: ArrayBuffer): Font;

  const opentype: { Font: typeof Font; parse: typeof parse };
  export default opentype;
}
