import { describe, expect, it } from 'vitest';
import { validateRebaselineRequest } from '../scripts/release/prepareRebaseline';

const target = 'a'.repeat(40);
const deployed = 'b'.repeat(40);
const apkBase = 'c'.repeat(40);
const request = {
  targetSourceSha: target,
  confirmTargetSourceSha: target,
  checkedOutSourceSha: target,
  expectedDeployedHeadSha: deployed,
  expectedApkBaseSha: apkBase,
  confirmRebaseline: 'REBASELINE',
  githubEventName: 'workflow_dispatch',
};

describe('指定源码 SHA 重基线授权', () => {
  it('允许 deployedHeadSha 与 apkBaseSha 不同但分别精确匹配', () => {
    expect(validateRebaselineRequest(request, { deployedHeadSha: deployed, apkBaseSha: apkBase })).toEqual({
      targetSourceSha: target,
      expectedDeployedHeadSha: deployed,
      expectedApkBaseSha: apkBase,
    });
  });

  it('拒绝缩写 SHA、checkout 身份不一致和错误确认词', () => {
    expect(() => validateRebaselineRequest({ ...request, targetSourceSha: target.slice(0, 7) }, { deployedHeadSha: deployed, apkBaseSha: apkBase }))
      .toThrow(/完整 40 位/);
    expect(() => validateRebaselineRequest({ ...request, checkedOutSourceSha: 'd'.repeat(40) }, { deployedHeadSha: deployed, apkBaseSha: apkBase }))
      .toThrow(/必须完全一致/);
    expect(() => validateRebaselineRequest({ ...request, confirmRebaseline: 'yes' }, { deployedHeadSha: deployed, apkBaseSha: apkBase }))
      .toThrow(/REBASELINE/);
  });

  it('远端任一 baseline 漂移时拒绝过期授权', () => {
    expect(() => validateRebaselineRequest(request, { deployedHeadSha: 'd'.repeat(40), apkBaseSha: apkBase }))
      .toThrow(/deployedHeadSha 已变化/);
    expect(() => validateRebaselineRequest(request, { deployedHeadSha: deployed, apkBaseSha: 'd'.repeat(40) }))
      .toThrow(/apkBaseSha 已变化/);
  });

  it('拒绝普通 push、空 baseline 和半初始化状态', () => {
    expect(() => validateRebaselineRequest({ ...request, githubEventName: 'push' }, { deployedHeadSha: deployed, apkBaseSha: apkBase }))
      .toThrow(/workflow_dispatch/);
    expect(() => validateRebaselineRequest(request, { deployedHeadSha: null, apkBaseSha: apkBase }))
      .toThrow(/baseline 不完整/);
  });
});
