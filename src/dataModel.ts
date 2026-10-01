/** Runtime-free ID brand compatible with Convex document IDs. */
export type Id<TableName extends string> = string & { __tableName: TableName };
