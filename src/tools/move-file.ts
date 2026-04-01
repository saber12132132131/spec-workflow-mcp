import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { rename, copyFile, unlink, stat, access, mkdir, readdir } from 'fs/promises';
import { constants } from 'fs';
import { resolve, normalize, dirname, basename, join } from 'path';
import { ToolContext, ToolResponse } from '../types.js';

/**
 * Recursively copy a file or directory to dest.
 */
async function copyRecursive(src: string, dest: string): Promise<void> {
  const srcStat = await stat(src);
  if (srcStat.isDirectory()) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src);
    for (const entry of entries) {
      await copyRecursive(join(src, entry), join(dest, entry));
    }
  } else {
    await copyFile(src, dest);
  }
}

/**
 * Recursively remove a file or directory.
 */
async function removeRecursive(target: string): Promise<void> {
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    const entries = await readdir(target);
    for (const entry of entries) {
      await removeRecursive(join(target, entry));
    }
    const { rmdir } = await import('fs/promises');
    await rmdir(target);
  } else {
    await unlink(target);
  }
}

/**
 * Validate that a path does not reference system directories or use traversal.
 */
function validatePath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  const absolutePath = resolve(normalize(filePath));

  const systemPaths = ['/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc'];
  const windowsSystemPaths = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
  const forbidden = process.platform === 'win32' ? windowsSystemPaths : systemPaths;

  for (const sys of forbidden) {
    if (absolutePath.toLowerCase().startsWith(sys.toLowerCase())) {
      throw new Error(`Access to system directory not allowed: ${absolutePath}`);
    }
  }

  return absolutePath;
}

export const moveFileTool: Tool = {
  name: 'move-file',
  description: `Move or rename a file or directory from one location to another (Linux/macOS/Windows).

# Instructions
Provide absolute paths for both source and destination.
- If the destination is an existing directory the source will be moved inside it.
- If the destination path does not exist, the source is renamed to that path (parent directories are created automatically).
- Works across different filesystems by falling back to copy-then-delete when needed.`,
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Absolute path to the source file or directory to move'
      },
      destination: {
        type: 'string',
        description: 'Absolute path to the destination file/directory or parent directory'
      }
    },
    required: ['source', 'destination']
  }
};

export async function moveFileHandler(args: any, _context: ToolContext): Promise<ToolResponse> {
  const { source, destination } = args;

  let srcPath: string;
  let destPath: string;

  try {
    srcPath = validatePath(source);
    destPath = validatePath(destination);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    // Ensure source exists
    await access(srcPath, constants.F_OK);
  } catch {
    return {
      success: false,
      message: `Source path does not exist: ${srcPath}`
    };
  }

  try {
    // If destination is an existing directory, move source inside it
    let finalDest = destPath;
    try {
      const destStat = await stat(destPath);
      if (destStat.isDirectory()) {
        finalDest = join(destPath, basename(srcPath));
      }
    } catch {
      // destination does not exist yet — ensure its parent directory exists
      const parentDir = dirname(destPath);
      await mkdir(parentDir, { recursive: true });
    }

    // Attempt atomic rename first (works within the same filesystem)
    try {
      await rename(srcPath, finalDest);
    } catch (err: any) {
      if (err.code === 'EXDEV') {
        // Cross-device move: copy recursively then delete
        await copyRecursive(srcPath, finalDest);
        await removeRecursive(srcPath);
      } else {
        throw err;
      }
    }

    return {
      success: true,
      message: `Successfully moved '${srcPath}' to '${finalDest}'`,
      data: {
        source: srcPath,
        destination: finalDest
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to move file: ${errorMessage}`
    };
  }
}
