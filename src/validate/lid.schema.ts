import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

export const lidToJidSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    lid: {
      type: 'string',
      pattern: '^\\d+@lid$',
      description: 'Invalid lid format. Expected: 08392017421739217@lid',
    },
  },
  required: ['lid'],
};
