/* zcode-workflow
description: Implement a bounded change, review in a fresh role, repair and run a Node test.
whenToUse: A small Node project with an already reviewed test file and explicit ownership.
args:
  task:
    type: string
    required: true
  testFile:
    type: string
    required: true
*/
// Controller: review this whole file, task/testFile, and the exact Node runtime
// before binding its hash and args. Native roles share tools: personas are not
// a read-only sandbox. Keep production, credentials and publishing out of task.
const implementer = agent('implementer', 'Implement only the assigned paths. Preserve other work. Do not delegate or publish.');
phase('implementation');
const implementation = await implementer.ask(String(args.task));
const reviewer = agent('reviewer', 'Inspect actual files and requirements independently. Report concrete defects. Do not edit, delegate or publish.');
phase('review');
const review = await reviewer.ask('Review this task and its actual changes: ' + String(args.task) + '\nImplementation report:\n' + implementation);
phase('repair');
const repair = await implementer.ask('Address only confirmed in-scope findings, inspect your fixes and explain remaining limitations.\n' + review);
phase('validation');
const validation = await world.run('node', ['--test', String(args.testFile)], { timeoutMs: 60000 });
report({ implementation, review, repair, validation });
if (validation.exitCode !== 0) throw new Error('Validation failed; inspect the recorded output before retrying.');
return { tested: true, review, repair };
