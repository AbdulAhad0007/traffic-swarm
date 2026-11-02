// Who may call each endpoint of the camera service. Unlisted paths are refused.
// READ: anyone, while the module is on. VIDEO: an admin, or anyone once 'public-video' is switched on. ADMIN: admin only.
const READ = 'read', VIDEO = 'video', ADMIN = 'admin';
const ID = '[A-Za-z0-9_-]+';
const NAME = '(frigate|go2rtc)';

const RULES = [
  ['GET', 'health', READ],
  ['GET', 'overview', READ],
  ['GET', 'stream', READ],
  ['GET', 'events', READ],
  ['GET', 'topology', READ],
  ['GET', 'agents', READ],
  ['GET', 'signal', READ],
  ['GET', 'signal/decisions', READ],
  ['GET', 'signal/proposals', READ],
  ['GET', 'cameras', READ],
  ['GET', `cameras/${ID}`, READ],
  ['GET', `cameras/${ID}/health`, READ],
  ['GET', `cameras/${ID}/frame-stats`, READ],
  ['GET', `cameras/${ID}/detections`, READ],
  ['GET', `cameras/${ID}/analytics`, READ],
  ['GET', `cameras/${ID}/frame\\.jpg`, VIDEO],
  ['POST', 'cameras', ADMIN],
  ['PATCH', `cameras/${ID}`, ADMIN],
  ['DELETE', `cameras/${ID}`, ADMIN],
  ['POST', `cameras/${ID}/(start|stop|reconnect|test)`, ADMIN],
  ['GET', 'test-sources', ADMIN],
  ['POST', 'test-sources', ADMIN],
  ['GET', 'infra', ADMIN],
  ['POST', `infra/${NAME}`, ADMIN],
  ['POST', `infra/${NAME}/(test|reconnect)`, ADMIN],
  ['GET', 'frigate/events', ADMIN],
  ['POST', 'signal/mode', ADMIN],
].map(([method, path, access]) => ({ method, re: new RegExp(`^${path}$`), access }));

const refuse = (error, detail) => ({ allowed: false, error, detail });

// localDevVideo: the caller is the development server on localhost. It opens video only, never an ADMIN endpoint.
export function checkCameraRequest(config, method, segments, isAdmin, { localDevVideo = false } = {}) {
  const rule = RULES.find(r => r.method === method && r.re.test(segments.join('/')));
  if (!rule) return refuse('endpoint_not_allowed', 'This endpoint is not available.');
  const module = config.modules['live-camera'];
  if (!module?.enabled) return refuse('module_disabled', 'This feature is currently unavailable.');
  if (rule.access === ADMIN && !isAdmin) return refuse('admin_required', 'Sign in as an administrator to do this.');
  if (rule.access === VIDEO && !isAdmin && !localDevVideo && module.sections['public-video'] !== true) return refuse('video_restricted', 'Video previews are available to signed-in administrators.');
  return { allowed: true };
}
