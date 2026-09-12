// Explicit Vulkan layer: expose exactly one physical device, selected by UUID.
// No global driver configuration is changed. Loaded only in GPU worker processes.
#include <vulkan/vulkan.h>
#include <vulkan/vk_layer.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

typedef struct Instance {
    VkInstance handle;
    VkPhysicalDevice selected;
    char uuid[33];
    PFN_vkGetInstanceProcAddr gipa;
    struct Instance *next;
} Instance;
typedef struct Device {
    VkDevice handle;
    PFN_vkGetDeviceProcAddr gdpa;
    struct Device *next;
} Device;
static Instance *instances;
static Device *devices;
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static Instance *instance_for(VkInstance handle) {
    pthread_mutex_lock(&mutex);
    Instance *p = instances;
    while (p && p->handle != handle) p = p->next;
    pthread_mutex_unlock(&mutex);
    return p;
}
static Instance *physical_for(VkPhysicalDevice handle) {
    pthread_mutex_lock(&mutex);
    Instance *p = instances;
    while (p && p->selected != handle) p = p->next;
    pthread_mutex_unlock(&mutex);
    return p;
}
static Device *device_for(VkDevice handle) {
    pthread_mutex_lock(&mutex);
    Device *p = devices;
    while (p && p->handle != handle) p = p->next;
    pthread_mutex_unlock(&mutex);
    return p;
}
static void hex_uuid(const uint8_t *uuid, char *out) {
    for (uint32_t i = 0; i < VK_UUID_SIZE; i++) snprintf(out + i * 2, 3, "%02x", uuid[i]);
}
static VKAPI_ATTR VkResult VKAPI_CALL hcCreateInstance(const VkInstanceCreateInfo *info,
        const VkAllocationCallbacks *alloc, VkInstance *out) {
    const char *wanted = getenv("HASHCATS_GPU_UUID");
    if (!wanted || strlen(wanted) != 32) return VK_ERROR_INITIALIZATION_FAILED;
    VkLayerInstanceCreateInfo *link = (VkLayerInstanceCreateInfo *)info->pNext;
    while (link && !(link->sType == VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO && link->function == VK_LAYER_LINK_INFO))
        link = (VkLayerInstanceCreateInfo *)link->pNext;
    if (!link || !link->u.pLayerInfo) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr gipa = link->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    PFN_vkCreateInstance create = (PFN_vkCreateInstance)gipa(VK_NULL_HANDLE, "vkCreateInstance");
    link->u.pLayerInfo = link->u.pLayerInfo->pNext;
    if (!create) return VK_ERROR_INITIALIZATION_FAILED;
    VkResult result = create(info, alloc, out);
    if (result != VK_SUCCESS) return result;
    PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)gipa(*out, "vkDestroyInstance");
    PFN_vkEnumeratePhysicalDevices enumerate = (PFN_vkEnumeratePhysicalDevices)gipa(*out, "vkEnumeratePhysicalDevices");
    PFN_vkGetPhysicalDeviceProperties2 properties = (PFN_vkGetPhysicalDeviceProperties2)gipa(*out, "vkGetPhysicalDeviceProperties2");
    Instance *state = calloc(1, sizeof(*state));
    uint32_t count = 0, matches = 0;
    VkPhysicalDevice *physical = NULL;
    if (!state || !enumerate || !properties) goto fail;
    if (enumerate(*out, &count, NULL) != VK_SUCCESS || !count) goto fail;
    physical = calloc(count, sizeof(*physical));
    if (!physical || enumerate(*out, &count, physical) != VK_SUCCESS) goto fail;
    for (uint32_t i = 0; i < count; i++) {
        VkPhysicalDeviceIDProperties id = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES};
        VkPhysicalDeviceProperties2 props = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &id};
        properties(physical[i], &props);
        char uuid[33]; hex_uuid(id.deviceUUID, uuid);
        if (!strcmp(uuid, wanted) && props.properties.deviceType != VK_PHYSICAL_DEVICE_TYPE_CPU) {
            state->selected = physical[i]; matches++;
        }
    }
    if (matches != 1) goto fail;
    free(physical);
    state->handle = *out; state->gipa = gipa; strcpy(state->uuid, wanted);
    pthread_mutex_lock(&mutex);
    state->next = instances; instances = state;
    pthread_mutex_unlock(&mutex);
    return VK_SUCCESS;
fail:
    free(physical); free(state); destroy(*out, alloc); *out = VK_NULL_HANDLE;
    return VK_ERROR_INITIALIZATION_FAILED;
}
static VKAPI_ATTR void VKAPI_CALL hcDestroyInstance(VkInstance handle, const VkAllocationCallbacks *alloc) {
    Instance *state = instance_for(handle);
    if (!state) return;
    PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)state->gipa(handle, "vkDestroyInstance");
    pthread_mutex_lock(&mutex);
    Instance **p = &instances;
    while (*p && *p != state) p = &(*p)->next;
    if (*p) *p = state->next;
    pthread_mutex_unlock(&mutex);
    destroy(handle, alloc); free(state);
}
static VKAPI_ATTR VkResult VKAPI_CALL hcEnumeratePhysicalDevices(VkInstance handle, uint32_t *count, VkPhysicalDevice *out) {
    Instance *state = instance_for(handle);
    if (!state) return VK_ERROR_INITIALIZATION_FAILED;
    if (!out) { *count = 1; return VK_SUCCESS; }
    if (!*count) return VK_INCOMPLETE;
    out[0] = state->selected; *count = 1; return VK_SUCCESS;
}
static VKAPI_ATTR VkResult VKAPI_CALL hcEnumeratePhysicalDeviceGroups(VkInstance handle, uint32_t *count,
        VkPhysicalDeviceGroupProperties *out) {
    Instance *state = instance_for(handle);
    if (!state) return VK_ERROR_INITIALIZATION_FAILED;
    if (!out) { *count = 1; return VK_SUCCESS; }
    if (!*count) return VK_INCOMPLETE;
    out[0].physicalDeviceCount = 1; out[0].physicalDevices[0] = state->selected;
    out[0].subsetAllocation = VK_FALSE; *count = 1;
    return VK_SUCCESS;
}
static VKAPI_ATTR VkResult VKAPI_CALL hcCreateDevice(VkPhysicalDevice physical, const VkDeviceCreateInfo *info,
        const VkAllocationCallbacks *alloc, VkDevice *out) {
    Instance *state = physical_for(physical);
    if (!state) return VK_ERROR_INITIALIZATION_FAILED;
    VkLayerDeviceCreateInfo *link = (VkLayerDeviceCreateInfo *)info->pNext;
    while (link && !(link->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO && link->function == VK_LAYER_LINK_INFO))
        link = (VkLayerDeviceCreateInfo *)link->pNext;
    if (!link || !link->u.pLayerInfo) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr gipa = link->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    PFN_vkGetDeviceProcAddr gdpa = link->u.pLayerInfo->pfnNextGetDeviceProcAddr;
    PFN_vkCreateDevice create = (PFN_vkCreateDevice)gipa(state->handle, "vkCreateDevice");
    link->u.pLayerInfo = link->u.pLayerInfo->pNext;
    Device *device = calloc(1, sizeof(*device));
    if (!device) return VK_ERROR_OUT_OF_HOST_MEMORY;
    VkResult result = create(physical, info, alloc, out);
    if (result != VK_SUCCESS) { free(device); return result; }
    // The worker checks this acknowledgement after Dawn creates its actual device.
    const char *ack = getenv("HASHCATS_GPU_ACK");
    int fd = ack ? open(ack, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600) : -1;
    int ok = fd >= 0 && write(fd, state->uuid, 32) == 32;
    if (fd >= 0) close(fd);
    if (!ok) {
        ((PFN_vkDestroyDevice)gdpa(*out, "vkDestroyDevice"))(*out, alloc);
        free(device); *out = VK_NULL_HANDLE; return VK_ERROR_INITIALIZATION_FAILED;
    }
    device->handle = *out; device->gdpa = gdpa;
    pthread_mutex_lock(&mutex);
    device->next = devices; devices = device;
    pthread_mutex_unlock(&mutex);
    return VK_SUCCESS;
}
static VKAPI_ATTR void VKAPI_CALL hcDestroyDevice(VkDevice handle, const VkAllocationCallbacks *alloc) {
    Device *state = device_for(handle);
    if (!state) return;
    PFN_vkDestroyDevice destroy = (PFN_vkDestroyDevice)state->gdpa(handle, "vkDestroyDevice");
    pthread_mutex_lock(&mutex);
    Device **p = &devices;
    while (*p && *p != state) p = &(*p)->next;
    if (*p) *p = state->next;
    pthread_mutex_unlock(&mutex);
    destroy(handle, alloc); free(state);
}
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL hcGetDeviceProcAddr(VkDevice handle, const char *name) {
    if (!strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)hcGetDeviceProcAddr;
    if (!strcmp(name, "vkDestroyDevice")) return (PFN_vkVoidFunction)hcDestroyDevice;
    Device *state = device_for(handle);
    return state ? state->gdpa(handle, name) : NULL;
}
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL hcGetInstanceProcAddr(VkInstance handle, const char *name) {
#define PROC(vk, hc) if (!strcmp(name, vk)) return (PFN_vkVoidFunction)hc
    PROC("vkGetInstanceProcAddr", hcGetInstanceProcAddr);
    PROC("vkCreateInstance", hcCreateInstance);
    PROC("vkDestroyInstance", hcDestroyInstance);
    PROC("vkEnumeratePhysicalDevices", hcEnumeratePhysicalDevices);
    PROC("vkEnumeratePhysicalDeviceGroups", hcEnumeratePhysicalDeviceGroups);
    PROC("vkEnumeratePhysicalDeviceGroupsKHR", hcEnumeratePhysicalDeviceGroups);
    PROC("vkCreateDevice", hcCreateDevice);
    PROC("vkGetDeviceProcAddr", hcGetDeviceProcAddr);
    PROC("vkDestroyDevice", hcDestroyDevice);
#undef PROC
    Instance *state = instance_for(handle);
    return state ? state->gipa(handle, name) : NULL;
}
VKAPI_ATTR VkResult VKAPI_CALL vkNegotiateLoaderLayerInterfaceVersion(VkNegotiateLayerInterface *version) {
    if (version->loaderLayerInterfaceVersion < 2) return VK_ERROR_INITIALIZATION_FAILED;
    version->loaderLayerInterfaceVersion = 2;
    version->pfnGetInstanceProcAddr = hcGetInstanceProcAddr;
    version->pfnGetDeviceProcAddr = hcGetDeviceProcAddr;
    version->pfnGetPhysicalDeviceProcAddr = NULL;
    return VK_SUCCESS;
}
