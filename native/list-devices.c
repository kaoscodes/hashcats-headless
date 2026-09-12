#include <vulkan/vulkan.h>
#include <stdio.h>
#include <stdlib.h>

static void json_string(const char *text) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
int main(void) {
    VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "hashcats-discovery", .apiVersion = VK_API_VERSION_1_1};
    VkInstanceCreateInfo info = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
    VkInstance instance;
    VkResult result = vkCreateInstance(&info, NULL, &instance);
    if (result != VK_SUCCESS) { fprintf(stderr, "Vulkan initialization failed (%d)\n", result); return 1; }
    uint32_t count = 0;
    if (vkEnumeratePhysicalDevices(instance, &count, NULL) != VK_SUCCESS) return 1;
    VkPhysicalDevice *devices = calloc(count ? count : 1, sizeof(*devices));
    if (!devices || vkEnumeratePhysicalDevices(instance, &count, devices) != VK_SUCCESS) return 1;
    putchar('[');
    for (uint32_t i = 0; i < count; i++) {
        VkPhysicalDeviceIDProperties id = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES};
        VkPhysicalDeviceProperties2 props = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &id};
        vkGetPhysicalDeviceProperties2(devices[i], &props);
        if (i) putchar(',');
        printf("{\"index\":%u,\"uuid\":\"", i);
        for (uint32_t b = 0; b < VK_UUID_SIZE; b++) printf("%02x", id.deviceUUID[b]);
        printf("\",\"name\":"); json_string(props.properties.deviceName);
        printf(",\"vendorId\":%u,\"deviceType\":%u}", props.properties.vendorID, props.properties.deviceType);
    }
    puts("]"); free(devices); vkDestroyInstance(instance, NULL); return 0;
}
