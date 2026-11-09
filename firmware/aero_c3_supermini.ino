/**
 * AeroTwin C3 - Universal HVAC Telemetry & Remote Control Node
 * Target Board: ESP32-C3 SuperMini (RISC-V 160MHz)
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <esp_task_wdt.h>

// Pinout Mapping ESP32-C3 SuperMini
#define PIN_ADC_SCT013       0
#define PIN_ADC_DRAIN_LEVEL  1
#define PIN_ONEWIRE_DS18B20  2
#define PIN_RMT_IR_RX        3
#define PIN_RMT_IR_TX        4
#define PIN_RS485_DERE       5
#define PIN_RS485_TX         6
#define PIN_RS485_RX         7

const char* WIFI_SSID     = "ISP_SHELTER_NET";
const char* WIFI_PASS     = "supersecret123";
const char* MQTT_BROKER   = "10.20.4.10";
const int   MQTT_PORT     = 1883;

WiFiClient espClient;
PubSubClient mqtt(espClient);
OneWire oneWire(PIN_ONEWIRE_DS18B20);
DallasTemperature sensors(&oneWire);

unsigned long lastTelemetryMillis = 0;

void handleMqttCommand(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  // Eksekusi transmisi RS485 Modbus atau RMT IR Blaster 38kHz
  digitalWrite(PIN_RS485_DERE, HIGH);
  Serial1.print(msg);
  Serial1.flush();
  digitalWrite(PIN_RS485_DERE, LOW);
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, PIN_RS485_RX, PIN_RS485_TX);

  pinMode(PIN_RS485_DERE, OUTPUT);
  digitalWrite(PIN_RS485_DERE, LOW);

  // Hardware Watchdog 15 Detik
  esp_task_wdt_init(15, true);
  esp_task_wdt_add(NULL);

  sensors.begin();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(handleMqttCommand);
}

void loop() {
  esp_task_wdt_reset();

  if (WiFi.status() == WL_CONNECTED && !mqtt.connected()) {
    if (mqtt.connect("ESP32C3-POP-04")) {
      mqtt.subscribe("aerotwin/c3/pop04/cmd");
    }
  }
  mqtt.loop();

  if (millis() - lastTelemetryMillis >= 2000) {
    lastTelemetryMillis = millis();
    sensors.requestTemperatures();
    float tempIn  = sensors.getTempCByIndex(0);
    float tempOut = sensors.getTempCByIndex(1);

    int rawCt = analogRead(PIN_ADC_SCT013);
    int rawDrain = analogRead(PIN_ADC_DRAIN_LEVEL);

    char payload[200];
    snprintf(payload, sizeof(payload),
      "{\"t_in\":%.2f,\"t_out\":%.2f,\"dt\":%.2f,\"ct_raw\":%d,\"drain\":%d,\"heap\":%u}",
      tempIn, tempOut, (tempIn - tempOut), rawCt, rawDrain, ESP.getFreeHeap()
    );
    mqtt.publish("aerotwin/c3/pop04/telemetry", payload);
  }
}
