import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

describe('MCP configuration', () => {
  it('defaults to loopback with explicit local allowlists', () => {
    const config = readConfig({});
    expect(config.runtimeMode).toBe('local');
    expect(config.bindHost).toBe('127.0.0.1');
    expect(config.port).toBe(3001);
    expect(config.allowedHosts).toEqual(['127.0.0.1', 'localhost', '[::1]']);
    expect(config.allowedOrigins).toContain('http://localhost:6274');
    expect(config.environment).toBe('development');
  });

  it('accepts explicit configuration without changing the secure defaults', () => {
    expect(
      readConfig({
        MCP_PORT: '3456',
        MCP_BIND_HOST: '0.0.0.0',
        MCP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
        MCP_ALLOWED_ORIGINS: 'http://localhost:3456',
        NODE_ENV: 'production',
        MCP_PROTOCOL_VERSION: '2025-11-25',
      }),
    ).toMatchObject({
      bindHost: '0.0.0.0',
      port: 3456,
      allowedOrigins: ['http://localhost:3456'],
      environment: 'production',
    });
    expect(readConfig({}).bindHost).toBe('127.0.0.1');
  });

  it.each([
    { MCP_PORT: '-1' },
    { MCP_PORT: '65536' },
    { MCP_PORT: 'not-a-port' },
    { MCP_PORT: '1.5' },
    { MCP_ALLOWED_HOSTS: '*' },
    { MCP_ALLOWED_HOSTS: 'localhost:3001' },
    { MCP_ALLOWED_HOSTS: 'localhost,' },
    { MCP_ALLOWED_ORIGINS: '*' },
    { MCP_ALLOWED_ORIGINS: 'null' },
    { MCP_ALLOWED_ORIGINS: 'http://localhost:3001/path' },
    { MCP_ALLOWED_ORIGINS: 'http://user:password@localhost:3001' },
    { MCP_ALLOWED_ORIGINS: 'file://localhost' },
    { MCP_BIND_HOST: 'invalid host' },
    { NODE_ENV: 'arbitrary-private-value' },
    { MCP_PROTOCOL_VERSION: '2026-07-28' },
  ])('fails closed for invalid configuration %j', (env) => {
    expect(() => readConfig(env)).toThrow();
  });

  it('freezes the AgentCore MCP container contract', () => {
    expect(
      readConfig({
        CLIENTOPS_MCP_RUNTIME: 'agentcore',
        CLIENTOPS_DATABASE_TARGET: 'staging',
        CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      runtimeMode: 'agentcore',
      bindHost: '0.0.0.0',
      port: 8000,
      allowedHosts: [],
      allowedOrigins: [],
      environment: 'production',
    });
  });

  it.each([
    {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'local',
      CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
      NODE_ENV: 'production',
    },
    {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'staging',
      NODE_ENV: 'production',
    },
    {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'staging',
      CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
      NODE_ENV: 'development',
    },
    {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'staging',
      CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
      NODE_ENV: 'production',
      MCP_BIND_HOST: '127.0.0.1',
    },
    {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'staging',
      CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
      NODE_ENV: 'production',
      MCP_PORT: '3001',
    },
    {
      CLIENTOPS_MCP_RUNTIME: 'agentcore',
      CLIENTOPS_DATABASE_TARGET: 'staging',
      CLIENTOPS_DATABASE_WORKLOAD: 'mcp',
      NODE_ENV: 'production',
      MCP_ALLOWED_ORIGINS: 'https://example.com',
    },
    {
      CLIENTOPS_MCP_RUNTIME: 'unknown',
    },
  ])('fails closed for invalid AgentCore configuration %j', (env) => {
    expect(() => readConfig(env)).toThrow();
  });

  it('does not leak or depend on unrelated environment configuration', () => {
    expect(readConfig({ UNUSED_TEST_SENTINEL: 'not-public' })).toEqual(
      readConfig({}),
    );
  });
});
