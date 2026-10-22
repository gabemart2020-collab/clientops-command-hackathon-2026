import { NextResponse } from 'next/server';
import { DeterministicDemoOrchestrator } from '@/lib/orchestrator';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const clientRef =
      typeof body.clientRef === 'string' && body.clientRef.trim()
        ? body.clientRef.trim()
        : 'Acme Labs';

    const orchestrator = new DeterministicDemoOrchestrator();
    const result = await orchestrator.runHeroWorkflow(clientRef);

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error: unknown) {
    const err = error as Error;
    const isMcpDown =
      err.message.includes('MCP_UNAVAILABLE') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('fetch failed');

    const statusCode = isMcpDown ? 503 : 400;

    return NextResponse.json(
      {
        success: false,
        error: err.message,
        code: isMcpDown ? 'MCP_UNAVAILABLE' : 'ORCHESTRATION_ERROR',
      },
      { status: statusCode },
    );
  }
}
