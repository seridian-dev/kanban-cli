/** Dynamic API references are intentionally typed at this CLI boundary. */
export interface CliConvexClient {
  query(reference: unknown, args: unknown): Promise<any>;
  mutation(reference: unknown, args: unknown): Promise<any>;
}
