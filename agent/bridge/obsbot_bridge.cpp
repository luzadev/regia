// Minimal C bridge over the OBSBOT device SDK (libdev).
//
// The SDK is a C++ class API, which an FFI cannot call directly. This file
// exposes the handful of camera operations Regia needs as plain C functions
// the Node camera agent loads with koffi. It is our code; the SDK itself is
// proprietary and is NOT part of this repository - see agent/README.md.
//
// Conventions: every function returns 0 on success and a negative code on
// failure; -1 SDK error, -2 no camera, -3 buffer too small. Text results are
// JSON written into caller-provided buffers. One camera per station: the first
// Tiny 2 series device found is used.

#include "dev/devs.hpp"

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

#if defined(_WIN32)
#define OB_EXPORT extern "C" __declspec(dllexport)
#else
#define OB_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace {

std::mutex g_mu;
std::shared_ptr<Device> g_dev;
std::string g_sn;
std::atomic<int> g_log_level{DEV_WARN};

// The SDK prints dozens of debug lines per call; keep warnings and errors.
void logHandler(int32_t lvl, const char *msg, va_list args, void *) {
  if (lvl > g_log_level.load()) return;
  std::fprintf(stderr, "[obsbot-sdk] ");
  std::vfprintf(stderr, msg, args);
  std::fprintf(stderr, "\n");
}

const char *modelName(int t) {
  switch (t) {
    case ObsbotProdTiny2Lite: return "Tiny 2 Lite";
    case ObsbotProdTiny2: return "Tiny 2";
    case ObsbotProdTiny4k: return "Tiny 4K";
    case ObsbotProdTiny: return "Tiny";
    case ObsbotProdTinySE: return "Tiny SE";
    default: return "OBSBOT";
  }
}

bool isTiny2Series(int t) { return t == ObsbotProdTiny2 || t == ObsbotProdTiny2Lite; }

// Picks the camera to drive. Caller holds g_mu.
bool acquire() {
  if (g_dev) return true;
  auto list = Devices::get().getDevList();
  std::shared_ptr<Device> any;
  for (auto &d : list) {
    if (!any) any = d;
    if (isTiny2Series(d->productType())) { g_dev = d; break; }
  }
  if (!g_dev) g_dev = any;
  if (g_dev) g_sn = g_dev->devSn();
  return (bool)g_dev;
}

int writeOut(char *buf, int len, const std::string &s) {
  if (!buf || len <= 0 || (int)s.size() + 1 > len) return -3;
  std::memcpy(buf, s.c_str(), s.size() + 1);
  return 0;
}

}  // namespace

/// Starts the SDK and waits up to wait_ms for a camera. Returns 0 when found.
OB_EXPORT int ob_init(int wait_ms, int log_level) {
  g_log_level = log_level > 0 ? log_level : DEV_WARN;
  dev_set_log_handler(logHandler, nullptr);
  Devices::get().setDevChangedCallback(
      [](std::string sn, bool connected, void *) {
        std::lock_guard<std::mutex> lock(g_mu);
        // The camera we drive went away: forget it, the agent re-acquires.
        if (!connected && sn == g_sn) { g_dev.reset(); g_sn.clear(); }
      },
      nullptr);
  Devices::get().setEnableMdnsScan(false);

  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(wait_ms);
  do {
    {
      std::lock_guard<std::mutex> lock(g_mu);
      if (acquire()) return 0;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  } while (std::chrono::steady_clock::now() < deadline);
  return -2;
}

/// Model, serial and firmware as JSON.
OB_EXPORT int ob_info(char *buf, int len) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  char out[512];
  std::snprintf(out, sizeof out,
                "{\"model\":\"%s\",\"product\":%d,\"sn\":\"%s\",\"firmware\":\"%s\"}",
                modelName(g_dev->productType()), g_dev->productType(), g_dev->devSn().c_str(),
                g_dev->devVersion().c_str());
  return writeOut(buf, len, out);
}

/// Gimbal motor angles, zoom and AI mode as JSON.
OB_EXPORT int ob_get_state(char *buf, int len) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  Device::AiGimbalStateInfo g{};
  if (g_dev->aiGetGimbalStateR(&g) != 0) return -1;
  float zoom = 0;
  if (g_dev->cameraGetZoomAbsoluteR(zoom) != 0) return -1;
  Device::CameraStatus st{};
  int ai = -1;
  int status = -1;  // DevStatus: 1 running, 3 asleep (the gimbal parks when asleep)
  if (g_dev->cameraGetCameraStatusU(st) == 0) {
    ai = st.tiny.ai_mode;
    status = st.tiny.dev_status;
  }
  char out[256];
  std::snprintf(out, sizeof out,
                "{\"pitch\":%.2f,\"yaw\":%.2f,\"zoom\":%.2f,\"ai_mode\":%d,\"dev_status\":%d}",
                g.pitch_motor, g.yaw_motor, zoom, ai, status);
  return writeOut(buf, len, out);
}

/// Wakes the camera. A Tiny with no stream falls asleep and parks its gimbal;
/// waking it is the first step before putting the framing back.
OB_EXPORT int ob_wake(void) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  return g_dev->cameraSetDevRunStatusR(Device::DevStatusRun) == 0 ? 0 : -1;
}

/// Turns AI tracking off. The SDK requires it before any manual gimbal move.
OB_EXPORT int ob_ai_off(void) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  return g_dev->cameraSetAiModeU(Device::AiWorkModeNone) == 0 ? 0 : -1;
}

/// Moves the gimbal to absolute motor angles, in degrees.
OB_EXPORT int ob_set_angle(float pitch, float yaw) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  return g_dev->aiSetGimbalMotorAngleR(pitch, yaw) == 0 ? 0 : -1;
}

/// Absolute zoom ratio (1.0 = no zoom).
OB_EXPORT int ob_set_zoom(float zoom) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  return g_dev->cameraSetZoomAbsoluteR(zoom) == 0 ? 0 : -1;
}

/// Enables or disables every hand gesture the Tiny 2 series understands.
/// On a floor-request show a guest raising a hand must never zoom the camera.
OB_EXPORT int ob_set_gestures(int enabled) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!acquire()) return -2;
  int worst = 0;
  // 0 target, 1 zoom, 2 dynamic zoom, 3 dynamic zoom direction (SDK header).
  for (int gesture = 0; gesture <= 3; gesture++) {
    if (g_dev->aiSetGestureCtrlIndividualR(gesture, enabled != 0) != 0) worst = -1;
  }
  return worst;
}
