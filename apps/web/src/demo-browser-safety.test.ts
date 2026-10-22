import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('demo browser explicit-execution contract', () => {
  it('does not dispatch model or deterministic workflows during mount or selection changes', () => {
    // Static regression guard until a DOM-based interaction test is installed.
    const source = readFileSync(
      new URL('./app/demo/page.tsx', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('useEffect(');
    expect(source).toContain('onClick={handleRun}');
    expect(source).toContain('onChange={(e) => selectClient(e.target.value)}');
    expect(source).toContain("onClick={() => changeMode('agentic')}");
    expect(source).toContain("onClick={() => changeMode('deterministic')}");
  });
});
