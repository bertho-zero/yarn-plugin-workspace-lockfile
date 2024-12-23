// from https://github.com/yarnpkg/berry/blob/017b94ae4eb20dea14ac673a053a1f2974b778ff/packages/plugin-essentials/sources/commands/install.ts#L377

import {
  Configuration,
  MessageName,
  ReportError,
  execUtils,
  structUtils,
} from '@yarnpkg/core';
import { xfs, ppath, Filename } from '@yarnpkg/fslib';
import { parseSyml, stringifySyml } from '@yarnpkg/parsers';

const MERGE_CONFLICT_START = `<<<<<<<`;

export default async function autofixMergeConflicts(configuration: Configuration, lockfileFilename: Filename, immutable: boolean) {
  if (!configuration.projectCwd)
    return false;

  const lockfilePath = ppath.join(configuration.projectCwd, lockfileFilename);
  if (!await xfs.existsPromise(lockfilePath))
    return false;

  const file = await xfs.readFilePromise(lockfilePath, `utf8`);
  if (!file.includes(MERGE_CONFLICT_START))
    return false;

  if (immutable)
    throw new ReportError(MessageName.AUTOMERGE_IMMUTABLE, `Cannot autofix a lockfile when running an immutable install`);

  let commits = await execUtils.execvp(`git`, [`rev-parse`, `MERGE_HEAD`, `HEAD`], {
    cwd: configuration.projectCwd,
  });

  if (commits.code !== 0) {
    commits = await execUtils.execvp(`git`, [`rev-parse`, `REBASE_HEAD`, `HEAD`], {
      cwd: configuration.projectCwd,
    });
  }

  if (commits.code !== 0) {
    commits = await execUtils.execvp(`git`, [`rev-parse`, `CHERRY_PICK_HEAD`, `HEAD`], {
      cwd: configuration.projectCwd,
    });
  }

  if (commits.code !== 0)
    throw new ReportError(MessageName.AUTOMERGE_GIT_ERROR, `Git returned an error when trying to find the commits pertaining to the conflict`);

  let variants = await Promise.all(commits.stdout.trim().split(/\n/).map(async hash => {
    const content = await execUtils.execvp(`git`, [`show`, `${hash}:./${lockfileFilename}`], {
      cwd: configuration.projectCwd!,
    });

    if (content.code !== 0)
      throw new ReportError(MessageName.AUTOMERGE_GIT_ERROR, `Git returned an error when trying to access the lockfile content in ${hash}`);

    try {
      return parseSyml(content.stdout);
    } catch {
      throw new ReportError(MessageName.AUTOMERGE_FAILED_TO_PARSE, `A variant of the conflicting lockfile failed to parse`);
    }
  }));

  // Old-style lockfiles should be filtered out (for example when switching
  // from a Yarn 2 branch to a Yarn 1 branch).
  variants = variants.filter(variant => {
    return !!variant.__metadata;
  });

  for (const variant of variants) {
    // Pre-lockfile v7, the entries weren't normalized (ie we had "foo@x.y.z"
    // in the lockfile rather than "foo@npm:x.y.z")
    if (variant.__metadata.version < 7) {
      for (const key of Object.keys(variant)) {
        if (key === `__metadata`)
          continue;

        const descriptor = structUtils.parseDescriptor(key, true);
        const normalizedDescriptor = configuration.normalizeDependency(descriptor);
        const newKey = structUtils.stringifyDescriptor(normalizedDescriptor);

        if (newKey !== key) {
          variant[newKey] = variant[key];
          delete variant[key];
        }
      }
    }

    // We encode the cacheKeys inside the checksums so that the reconciliation
    // can merge the data together
    for (const key of Object.keys(variant)) {
      if (key === `__metadata`)
        continue;

      const checksum = variant[key].checksum;
      if (typeof checksum === `string` && checksum.includes(`/`))
        continue;

      variant[key].checksum = `${variant.__metadata.cacheKey}/${checksum}`;
    }
  }

  const merged = Object.assign({}, ...variants);

  // We must keep the lockfile version as small as necessary to force Yarn to
  // refresh the merged-in lockfile metadata that may be missing.
  merged.__metadata.version = `${Math.min(...variants.map(variant => {
    return parseInt(variant.__metadata.version ?? 0);
  }))}`;

  // It shouldn't matter, since the cacheKey have been embed within the checksums
  merged.__metadata.cacheKey = `merged`;

  // parse as valid YAML except that the objects become strings. We can use
  // that to detect them. Damn, it's really ugly though.
  for (const [key, value] of Object.entries(merged))
    if (typeof value === `string`)
      delete merged[key];

  await xfs.changeFilePromise(lockfilePath, stringifySyml(merged), {
    automaticNewlines: true,
  });

  return true;
}
