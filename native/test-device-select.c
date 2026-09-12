// Test UUID filtering against two virtual Vulkan handles with identical names.
#include "device-select.c"
#include <assert.h>
#include <stdint.h>
static int duplicate_uuid;
static VkPhysicalDevice a = (VkPhysicalDevice)(uintptr_t)11;
static VkPhysicalDevice b = (VkPhysicalDevice)(uintptr_t)22;
static VkResult VKAPI_CALL fake_create(const VkInstanceCreateInfo *i, const VkAllocationCallbacks *c, VkInstance *out) {
    (void)i; (void)c; *out = (VkInstance)(uintptr_t)1; return VK_SUCCESS;
}
static void VKAPI_CALL fake_destroy(VkInstance i, const VkAllocationCallbacks *c) { (void)i; (void)c; }
static VkResult VKAPI_CALL fake_enumerate(VkInstance i, uint32_t *count, VkPhysicalDevice *out) {
    (void)i; if(out){out[0]=a;out[1]=b;} *count=2; return VK_SUCCESS;
}
static void VKAPI_CALL fake_properties(VkPhysicalDevice p, VkPhysicalDeviceProperties2 *props) {
    VkPhysicalDeviceIDProperties *id = props->pNext;
    memset(id->deviceUUID, p == a || duplicate_uuid ? 0x11 : 0x22, VK_UUID_SIZE);
    props->properties.deviceType = VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU;
    strcpy(props->properties.deviceName, "Identical GPU");
}
static PFN_vkVoidFunction VKAPI_CALL fake_gipa(VkInstance i, const char *name) {
    (void)i;
    if(!strcmp(name,"vkCreateInstance"))return (PFN_vkVoidFunction)fake_create;
    if(!strcmp(name,"vkDestroyInstance"))return (PFN_vkVoidFunction)fake_destroy;
    if(!strcmp(name,"vkEnumeratePhysicalDevices"))return (PFN_vkVoidFunction)fake_enumerate;
    if(!strcmp(name,"vkGetPhysicalDeviceProperties2"))return (PFN_vkVoidFunction)fake_properties;
    return NULL;
}
static VkResult create_test(VkInstance *instance) {
    VkLayerInstanceLink next = {.pfnNextGetInstanceProcAddr = fake_gipa};
    VkLayerInstanceCreateInfo chain = {.sType = VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO, .function = VK_LAYER_LINK_INFO};
    chain.u.pLayerInfo = &next;
    VkInstanceCreateInfo info = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pNext = &chain};
    return hcCreateInstance(&info,NULL,instance);
}
int main(void) {
    for(int choice=1;choice<=2;choice++) {
        char uuid[33]; memset(uuid,choice==1?'1':'2',32);uuid[32]=0;
        setenv("HASHCATS_GPU_UUID",uuid,1);
        VkInstance instance;assert(create_test(&instance)==VK_SUCCESS);
        uint32_t count=0;assert(hcEnumeratePhysicalDevices(instance,&count,NULL)==VK_SUCCESS&&count==1);
        VkPhysicalDevice out[2];count=2;
        assert(hcEnumeratePhysicalDevices(instance,&count,out)==VK_SUCCESS&&count==1);
        assert(out[0]==(choice==1?a:b));
        VkPhysicalDeviceGroupProperties group={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_GROUP_PROPERTIES};count=1;
        assert(hcEnumeratePhysicalDeviceGroups(instance,&count,&group)==VK_SUCCESS);
        assert(group.physicalDeviceCount==1&&group.physicalDevices[0]==out[0]);
        hcDestroyInstance(instance,NULL);
    }
    VkInstance instance;
    setenv("HASHCATS_GPU_UUID","33333333333333333333333333333333",1);
    assert(create_test(&instance)==VK_ERROR_INITIALIZATION_FAILED);
    setenv("HASHCATS_GPU_UUID","11111111111111111111111111111111",1);duplicate_uuid=1;
    assert(create_test(&instance)==VK_ERROR_INITIALIZATION_FAILED);
    unsetenv("HASHCATS_GPU_UUID");assert(create_test(&instance)==VK_ERROR_INITIALIZATION_FAILED);
    puts("UUID layer tests passed: identical GPUs, groups, unknown UUID, duplicate UUID, missing selector.");
    return 0;
}
