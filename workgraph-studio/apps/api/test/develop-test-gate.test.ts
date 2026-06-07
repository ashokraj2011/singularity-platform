import { describe, it, expect } from 'vitest'
import {
  stageRequiresUnitTests, isTestPath, isPassingTestReceipt, evaluateDevelopTestGate,
} from '../src/modules/blueprint/develop-test-gate'

describe('stageRequiresUnitTests', () => {
  it('true only when a required unit_tests artifact is declared', () => {
    expect(stageRequiresUnitTests([{ kind: 'unit_tests', required: true }])).toBe(true)
    expect(stageRequiresUnitTests([{ kind: 'unit_tests' }])).toBe(true) // required defaults true
    expect(stageRequiresUnitTests([{ kind: 'unit_tests', required: false }])).toBe(false)
    expect(stageRequiresUnitTests([{ kind: 'actual_code_change', required: true }])).toBe(false)
    expect(stageRequiresUnitTests(undefined)).toBe(false)
  })
})

describe('isTestPath', () => {
  it('recognizes test files across languages', () => {
    for (const p of [
      'src/test/java/org/example/FooTest.java',
      'app/__tests__/foo.test.ts', 'lib/foo.spec.jsx',
      'pkg/foo_test.go', 'tests/test_foo.py', 'foo/bar_test.py',
      'spec/models/user_spec.rb',
    ]) expect(isTestPath(p), p).toBe(true)
  })
  it('rejects production files', () => {
    for (const p of ['src/main/java/org/example/Foo.java', 'src/foo.ts', 'README.md', 'pkg/foo.go']) {
      expect(isTestPath(p), p).toBe(false)
    }
  })
})

describe('isPassingTestReceipt', () => {
  it('accepts a passing test run', () => {
    expect(isPassingTestReceipt({ command: 'mvn -Dtest=FooTest test', exit_code: 0, passed: true })).toBe(true)
    expect(isPassingTestReceipt({ command: 'pytest tests/', exit_code: 0 })).toBe(true)
    expect(isPassingTestReceipt({ command: 'go test ./...', exit_code: 0 })).toBe(true)
  })
  it('rejects non-test, failed, or no-tests-ran receipts', () => {
    expect(isPassingTestReceipt({ command: 'mvn compile', exit_code: 0 })).toBe(false) // not a test cmd
    expect(isPassingTestReceipt({ command: 'pytest', exit_code: 1, passed: false })).toBe(false) // failed
    expect(isPassingTestReceipt({ command: 'mvn test', exit_code: 0, no_tests_ran_reason: 'filter matched 0' })).toBe(false)
    expect(isPassingTestReceipt({ command: 'eslint .', exit_code: 0 })).toBe(false)
  })
})

describe('evaluateDevelopTestGate', () => {
  const passing = [{ command: 'pytest', exit_code: 0 }]
  it('ok when a test file was edited AND a test run passed', () => {
    const r = evaluateDevelopTestGate({ changedPaths: ['src/foo.py', 'tests/test_foo.py'], pathsKnown: true, receipts: passing })
    expect(r.ok).toBe(true)
  })
  it('blocks when no test file edited (paths known)', () => {
    const r = evaluateDevelopTestGate({ changedPaths: ['src/foo.py'], pathsKnown: true, receipts: passing })
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/no test file/i)
  })
  it('blocks when no passing test run', () => {
    const r = evaluateDevelopTestGate({ changedPaths: ['tests/test_foo.py'], pathsKnown: true, receipts: [{ command: 'mvn compile', exit_code: 0 }] })
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/passing test/i)
  })
  it('fails open on test-file check when paths unknown, but still needs a passing run', () => {
    expect(evaluateDevelopTestGate({ changedPaths: [], pathsKnown: false, receipts: passing }).ok).toBe(true)
    expect(evaluateDevelopTestGate({ changedPaths: [], pathsKnown: false, receipts: [] }).ok).toBe(false)
  })
})
