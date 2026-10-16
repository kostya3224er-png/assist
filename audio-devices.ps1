param([ValidateSet('list', 'set', 'transcribe')] [string]$Action = 'list', [string]$DeviceBase64)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
if ($Action -eq 'transcribe') {
  Add-Type -AssemblyName System.Speech
  $culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  if (-not ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $culture.Name })) { throw 'The Windows offline recognizer for English (en-US) is not installed.' }
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($DeviceBase64))
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  try {
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $engine.SetInputToWaveFile($path)
    $result = $engine.Recognize([TimeSpan]::FromSeconds(8))
    @{ text = if ($result) { $result.Text } else { '' }; confidence = if ($result) { $result.Confidence } else { 0 } } | ConvertTo-Json -Compress
  } finally { $engine.Dispose() }
  exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public enum ERole { eConsole, eMultimedia, eCommunications }
[StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int stateMask, [MarshalAs(UnmanagedType.Interface)] out IMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, ERole role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection { [PreserveSig] int GetCount(out uint count); [PreserveSig] int Item(uint index, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int context, IntPtr activation, out IntPtr instance);
  [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
  [PreserveSig] int GetId(out IntPtr id);
  [PreserveSig] int GetState(out int state);
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
  [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
  [PreserveSig] int Commit();
}
[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  [PreserveSig] int GetMixFormat(); [PreserveSig] int GetDeviceFormat(); [PreserveSig] int ResetDeviceFormat();
  [PreserveSig] int SetDeviceFormat(); [PreserveSig] int GetProcessingPeriod(); [PreserveSig] int SetProcessingPeriod();
  [PreserveSig] int GetShareMode(); [PreserveSig] int SetShareMode(); [PreserveSig] int GetPropertyValue();
  [PreserveSig] int SetPropertyValue();
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, ERole role);
  [PreserveSig] int SetEndpointVisibility();
}
[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] public class PolicyConfigClient { }
public static class AudioEndpoints {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT value);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr value);
  static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); }
  static string Id(IMMDevice device) { IntPtr p; Marshal.ThrowExceptionForHR(device.GetId(out p)); try { return Marshal.PtrToStringUni(p); } finally { CoTaskMemFree(p); } }
  static string Name(IMMDevice device) {
    IPropertyStore store; Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out store));
    PROPERTYKEY key = new PROPERTYKEY { fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid = 14 };
    PROPVARIANT value; Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
    try { return value.vt == 31 ? Marshal.PtrToStringUni(value.pointer) : "Audio device"; }
    finally { PropVariantClear(ref value); Marshal.ReleaseComObject(store); }
  }
  static string DefaultId(IMMDeviceEnumerator e, ERole role) {
    IMMDevice d; if (e.GetDefaultAudioEndpoint(0, role, out d) != 0) return "";
    try { return Id(d); } finally { Marshal.ReleaseComObject(d); }
  }
  public static object[] List() {
    var e = Enumerator(); IMMDeviceCollection c; Marshal.ThrowExceptionForHR(e.EnumAudioEndpoints(0, 1, out c));
    uint count; Marshal.ThrowExceptionForHR(c.GetCount(out count));
    string multimedia = DefaultId(e, ERole.eMultimedia), console = DefaultId(e, ERole.eConsole), communications = DefaultId(e, ERole.eCommunications);
    var items = new List<object>();
    for (uint i = 0; i < count; i++) { IMMDevice d; Marshal.ThrowExceptionForHR(c.Item(i, out d)); string id = Id(d); items.Add(new { id = id, name = Name(d), isDefault = id == multimedia, isDefaultConsole = id == console, isDefaultCommunications = id == communications }); Marshal.ReleaseComObject(d); }
    Marshal.ReleaseComObject(c); Marshal.ReleaseComObject(e); return items.ToArray();
  }
  public static void SetDefault(string id) {
    var p = (IPolicyConfig)new PolicyConfigClient();
    foreach (ERole role in Enum.GetValues(typeof(ERole))) Marshal.ThrowExceptionForHR(p.SetDefaultEndpoint(id, role));
    Marshal.ReleaseComObject(p);
  }
}
'@

if ($Action -eq 'list') { ConvertTo-Json -InputObject ([AudioEndpoints]::List()) -Compress -Depth 4 }
else { $deviceId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($DeviceBase64)); [AudioEndpoints]::SetDefault($deviceId); 'OK' }
