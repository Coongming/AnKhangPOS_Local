import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CommandResult = {
  stdout: string;
  stderr: string;
};

function isPostgresUrl(value: string | undefined): value is string {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
  } catch {
    return false;
  }
}

function commandName(command: string): string {
  if (process.platform === 'win32' && (command === 'pg_dump' || command === 'psql')) {
    return `${command}.exe`;
  }

  return command;
}

function cleanProcessEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (key && !key.startsWith('=') && value !== undefined) {
      env[key] = value;
    }
  }

  env.PGCONNECT_TIMEOUT = '20';
  Object.assign(env, overrides);
  return env;
}

function runCommand(
  command: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      commandName(command),
      args,
      {
        cwd: process.cwd(),
        env: cleanProcessEnv(envOverrides),
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: stdout || '',
          stderr: stderr || '',
        };

        if (error) {
          const details = result.stderr.trim() || error.message;
          reject(new Error(`${command} thất bại: ${details}`));
          return;
        }

        resolve(result);
      }
    );
  });
}

async function updateOnlineSchema(onlineDatabaseUrl: string): Promise<void> {
  const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

  await fs.access(prismaCli).catch(() => {
    throw new Error('Không tìm thấy Prisma CLI. Hãy chạy npm install trên máy hiện tại');
  });

  await runCommand(
    process.execPath,
    [prismaCli, 'db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'],
    {
      DATABASE_URL: onlineDatabaseUrl,
      DIRECT_URL: onlineDatabaseUrl,
    }
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sanitizeError(message: string, urls: string[]): string {
  return urls.reduce((result, url) => result.split(url).join('[DATABASE_URL]'), message);
}

async function getLocalTables(localDatabaseUrl: string): Promise<string[]> {
  const { stdout } = await runCommand('psql', [
    '-d',
    localDatabaseUrl,
    '-X',
    '-t',
    '-A',
    '-c',
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename;",
  ]);

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function POST() {
  const localDatabaseUrl = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;
  const onlineDatabaseUrl = process.env.SUPABASE_DIRECT_URL;

  if (!isPostgresUrl(localDatabaseUrl)) {
    return NextResponse.json(
      { error: 'LOCAL_DATABASE_URL hoặc DATABASE_URL local chưa được cấu hình đúng' },
      { status: 500 }
    );
  }

  if (!isPostgresUrl(onlineDatabaseUrl)) {
    return NextResponse.json(
      { error: 'SUPABASE_DIRECT_URL chưa được cấu hình đúng' },
      { status: 500 }
    );
  }

  let tempDir = '';

  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ankhangpos-sync-'));
    const dumpFile = path.join(tempDir, 'local-data.sql');
    const restoreFile = path.join(tempDir, 'restore-online.sql');

    await updateOnlineSchema(onlineDatabaseUrl);

    const tables = await getLocalTables(localDatabaseUrl);

    if (tables.length === 0) {
      throw new Error('Không tìm thấy bảng dữ liệu nào trong database local');
    }

    await runCommand('pg_dump', [
      '-d',
      localDatabaseUrl,
      '--data-only',
      '--no-owner',
      '--no-acl',
      '--schema=public',
      '--exclude-table=public._prisma_migrations',
      '--file',
      dumpFile,
    ]);

    const tableList = tables.map((table) => `public.${quoteIdentifier(table)}`).join(', ');
    const countSql = tables
      .map(
        (table) =>
          `SELECT 'SYNC_COUNT', ${quoteLiteral(table)}, count(*)::text FROM public.${quoteIdentifier(table)}`
      )
      .join(' UNION ALL ');
    const dumpPathForPsql = dumpFile.replace(/\\/g, '/').replace(/'/g, "''");
    const circularConstraints = [
      {
        table: 'products',
        constraint: 'products_blend_template_id_fkey',
      },
      {
        table: 'blend_templates',
        constraint: 'blend_templates_output_product_id_fkey',
      },
    ];
    const deferCircularConstraints = circularConstraints
      .map(
        ({ table, constraint }) =>
          `ALTER TABLE public.${quoteIdentifier(table)} ALTER CONSTRAINT ${quoteIdentifier(constraint)} DEFERRABLE INITIALLY IMMEDIATE;`
      )
      .join('\n');
    const restoreCircularConstraints = circularConstraints
      .map(
        ({ table, constraint }) =>
          `ALTER TABLE public.${quoteIdentifier(table)} ALTER CONSTRAINT ${quoteIdentifier(constraint)} NOT DEFERRABLE;`
      )
      .join('\n');

    const restoreSql = [
      '\\set ON_ERROR_STOP on',
      'BEGIN;',
      deferCircularConstraints,
      'SET CONSTRAINTS ALL DEFERRED;',
      `TRUNCATE TABLE ${tableList} CASCADE;`,
      `\\i '${dumpPathForPsql}'`,
      'SET CONSTRAINTS ALL IMMEDIATE;',
      restoreCircularConstraints,
      'COMMIT;',
      `${countSql};`,
    ].join('\n');

    await fs.writeFile(restoreFile, restoreSql, 'utf8');

    const { stdout, stderr } = await runCommand('psql', [
      '-d',
      onlineDatabaseUrl,
      '-X',
      '-t',
      '-A',
      '-F',
      '|',
      '-f',
      restoreFile,
    ]);

    const synced = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('SYNC_COUNT|'))
      .map((line) => {
        const [, table, count] = line.split('|');
        return { table, count: Number.parseInt(count, 10) };
      })
      .filter((row) => row.table && Number.isFinite(row.count));

    if (synced.length !== tables.length) {
      throw new Error('Đã ghi dữ liệu nhưng không kiểm tra được đầy đủ số dòng trên Supabase');
    }

    const totalRows = synced.reduce((sum, row) => sum + row.count, 0);
    const warnings = stderr
      .split(/\r?\n/)
      .filter((line) => /warning/i.test(line))
      .length;

    return NextResponse.json({
      success: true,
      message: `Đã cập nhật cấu trúc và đồng bộ thành công ${totalRows} dòng dữ liệu lên Supabase`,
      tables: synced,
      totalRows,
      warnings,
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Lỗi không xác định';
    const message = sanitizeError(rawMessage, [localDatabaseUrl, onlineDatabaseUrl]);

    return NextResponse.json(
      { error: `Đồng bộ thất bại: ${message}` },
      { status: 500 }
    );
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
