export const uuid = { type: 'string', format: 'uuid' };
export const bearerSecurity = [{ bearerAuth: [] }];

export function recordSchema(properties: Record<string, object>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
