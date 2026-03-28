export default [
  {
    name: 'fixture_multi_a',
    description: 'Multi fixture tool A',
    parameters: {},
    execute: async () => ({ success: true, data: 'a' }),
  },
  {
    name: 'fixture_multi_b',
    description: 'Multi fixture tool B',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute: async () => ({ success: true, data: 'b' }),
  },
]
