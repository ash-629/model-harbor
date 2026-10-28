import { grokResponsesPlan } from './src/responses-tools.js';
const body = {
  model: 'grok-4.7',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s' } }],
  tool_choice: { type: 'custom', name: 'apply_patch' }, store: false, stream: true
};
const plan = grokResponsesPlan(body);
console.log('transformed', plan.transformed);
console.log('tools', JSON.stringify(plan.request.tools));
console.log('choice', JSON.stringify(plan.request.tool_choice));
