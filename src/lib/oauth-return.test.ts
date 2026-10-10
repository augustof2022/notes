import { describe, expect, it } from 'vitest';
import { readOAuthReturn } from './oauth-return';

describe('Google sign-in returns', () => {
  it('explains the expired request returned by Supabase and preserves unrelated navigation', () => {
    const result = readOAuthReturn('https://example.com/notes/?board=123&error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+has+expired#section');
    expect(result?.message).toContain('expired');
    expect(result?.message).toContain('Continue with Google');
    expect(result?.url).toBe('https://example.com/notes/?board=123#section');
  });
  it.each(['flow_state_expired', 'flow_state_not_found'])('offers a new request for %s', code => {
    expect(readOAuthReturn(`https://example.com/notes/?error_code=${code}`)?.message).toContain('expired');
  });
  it('handles consent cancellation in the fragment', () => {
    const result = readOAuthReturn('https://example.com/notes/#error=access_denied&error_description=cancelled&board=123');
    expect(result?.message).toContain('not completed');
    expect(result?.url).toBe('https://example.com/notes/#board=123');
  });
  it('does not expose an arbitrary provider error description', () => {
    const result = readOAuthReturn('https://example.com/notes/?error=unknown&error_description=private-token');
    expect(result?.message).not.toContain('private-token');
    expect(result?.url).toBe('https://example.com/notes/');
  });
  it('leaves successful callbacks and ordinary navigation for Supabase to handle', () => {
    expect(readOAuthReturn('https://example.com/notes/#access_token=test&provider_token=test')).toBeNull();
    expect(readOAuthReturn('https://example.com/notes/?board=123#section')).toBeNull();
  });
});
