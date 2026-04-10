// generate_tool_code — LLM-powered code generation for samsinn tools.
// Bundled with the skill-builder skill. Uses context.llm() to produce
// a complete TypeScript module from a natural language prompt.

const SYSTEM_PROMPT = `You are a TypeScript code generator for samsinn tools.
Write a complete module that exports a tool object as the default export.

The tool object must have this exact shape:

const tool = {
  name: "<name>",
  description: "<description>",
  parameters: <JSON Schema object>,
  execute: async (params: Record<string, unknown>, context: any) => {
    // implementation
  },
}
export default tool

Available in params: values from the parameters schema, cast with \`as string\`, \`as number\` etc.
Available in context: callerId (string), callerName (string), roomId? (string), llm? (function for LLM calls).

The execute function MUST return one of:
  { success: true, data: <any value> }
  { success: false, error: "error message" }

Rules:
- No imports needed — write plain TypeScript
- No markdown fences, no explanation — just the module code
- Always validate inputs before using them
- Handle errors with try/catch`

const STRIP_FENCES = /^```\w*\n?|```\s*$/g

const tool = {
  name: 'generate_tool_code',
  description: 'Generates TypeScript source code for a samsinn tool from a natural language prompt.',
  usage: 'Describe what the tool should do in the prompt parameter. Returns the generated source code as a string. Pass the code to write_tool to save and register it.',
  returns: 'Object with a code field containing the complete TypeScript module source.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool name' },
      description: { type: 'string', description: 'What the tool does (one sentence)' },
      parameters: { type: 'object', description: 'JSON Schema for the tool parameters' },
      prompt: { type: 'string', description: 'Natural language description of what the code should do' },
    },
    required: ['name', 'description', 'parameters', 'prompt'],
  },
  execute: async (params: Record<string, unknown>, context: any) => {
    if (!context.llm) {
      return { success: false, error: 'LLM not available in tool context' }
    }

    const name = params.name as string
    const description = params.description as string
    const parameters = params.parameters as Record<string, unknown>
    const prompt = params.prompt as string

    if (!name || !description || !prompt) {
      return { success: false, error: 'name, description, and prompt are required' }
    }

    const userMessage = `Generate a tool with:
- name: ${JSON.stringify(name)}
- description: ${JSON.stringify(description)}
- parameters: ${JSON.stringify(parameters)}

Implementation: ${prompt}`

    try {
      const code = await context.llm({
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user' as const, content: userMessage }],
        temperature: 0.2,
      })

      const cleaned = code.replace(STRIP_FENCES, '').trim()
      return { success: true, data: { code: cleaned } }
    } catch (err: any) {
      return { success: false, error: `Code generation failed: ${err?.message ?? String(err)}` }
    }
  },
}

export default tool
