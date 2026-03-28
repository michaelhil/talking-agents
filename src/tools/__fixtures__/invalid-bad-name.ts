// Name contains a space — should be skipped by loader
export default {
  name: 'bad name here',
  description: 'Tool with invalid name format',
  parameters: {},
  execute: async () => ({ success: true }),
}
