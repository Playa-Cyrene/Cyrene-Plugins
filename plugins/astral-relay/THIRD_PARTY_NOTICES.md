# Third-party notices

The OAuth provider parameters (scopes, and how the authorize / token / device-code endpoints
are used) are adapted from / informed by:

- Cyrene-Plugins, `plugins/subscription-oauth`, version 1.2.7
- https://github.com/1971687396/Cyrene-Plugins/tree/codex/subscription-oauth-1.2.7
- Reference commit: `56655b12056e9048a661e338b2e38d7e1fc7e723`
- Plugin author: 1971687396. Repository license follows.

Scope note, kept accurate on purpose: this file once also covered Codex compatibility handling
and a Responses terminal-output repair. Both were deleted in 0.5.0's predecessor 0.4.0 along with
Codex itself, so neither is claimed here any more. The upstream request headers were rewritten to
identify this plugin honestly (`astral-relay/<version>`) rather than imitate a vendor CLI, and the
xAI endpoints are taken from xAI's own published OIDC discovery document — so neither is adapted
material either. What remains genuinely informed by the reference plugin is the OAuth parameter
set named above.

MIT License

Copyright (c) 2026 Playa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
