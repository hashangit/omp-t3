'use strict';

const { PassThrough } = require('node:stream');

/**
 * Creates paired readable and writable PassThrough streams for mocking stdio.
 */
function createMockStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return { stdin, stdout, stderr };
}

/**
 * Collects lines emitted by a stream into an array.
 * @param {import('node:stream').Readable} stream 
 * @returns {{ lines: string[], getJson: () => any[] }}
 */
function collectLines(stream) {
  const lines = [];
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (part.trim().length > 0) {
        lines.push(part);
      }
    }
  });

  return {
    lines,
    getJson: () => lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean)
  };
}

module.exports = {
  createMockStreams,
  collectLines
};
