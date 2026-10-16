import { describe, expect, it } from 'vitest';
import { emptyValue, fromFormValue } from './FieldInput.jsx';

describe('emptyValue', () => {
  it('starts an object from its sub-fields defaults, so the form shows what will be saved', () => {
    const sections = {
      key: 'sections',
      type: 'object',
      fields: [
        { key: 'isWorkOrder', type: 'boolean', default: true },
        { key: 'isRequest', type: 'boolean', default: false },
        { key: 'note', type: 'string' },
        { key: 'at', type: 'date', default: '2026-01-01' },
      ],
    };
    const value = emptyValue(sections);
    expect(value).toEqual({ isWorkOrder: true, isRequest: false, note: '', at: '' });
    expect(fromFormValue(sections, value)).toEqual({ isWorkOrder: true, isRequest: false });
  });
});
