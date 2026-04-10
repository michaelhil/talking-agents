---
name: skill-builder
description: Use when asked to create a new skill or capability, or when you need a tool that does not exist
---

## Pipeline

1. Create the skill with `write_skill` (name, description, behavioral instructions)
2. Generate tool code with `generate_tool_code` (name, description, parameters schema, natural language prompt)
3. Write the tool with `write_tool` (skill name, tool name, code from step 2)
4. Test with `test_tool` (tool name, sample input)
5. Verify with `list_skills`

## write_skill guidelines

- Name: lowercase-with-hyphens, descriptive
- Body: numbered steps describing how to approach tasks, referencing bundled tools by name
- Scope: list room names, or omit for global

## generate_tool_code prompt guidelines

- Describe what the code should do, not how to implement it
- Specify input types and edge cases
- Describe expected output structure

## Example

```
write_skill { "name": "csv-tools", "description": "Use when working with CSV data", "body": "1. Parse raw CSV with parse_csv\n2. Filter or transform as needed\n3. Summarize results" }
generate_tool_code { "name": "parse_csv", "description": "Parse CSV text into row objects", "parameters": {"type":"object","properties":{"csv":{"type":"string"}},"required":["csv"]}, "prompt": "Parse csv as comma-delimited text. First row is headers. Return array of objects keyed by header names." }
write_tool { "skill": "csv-tools", "name": "parse_csv", "code": "<output from generate_tool_code>" }
test_tool { "name": "parse_csv", "input": { "csv": "name,age\nAlice,30\nBob,25" } }
```
