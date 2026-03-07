declare module "pdf-parse" {
  const pdfParse: (dataBuffer: Buffer | Uint8Array) => Promise<{
    text: string;
    numpages?: number;
    numrender?: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
  }>;
  export default pdfParse;
}
