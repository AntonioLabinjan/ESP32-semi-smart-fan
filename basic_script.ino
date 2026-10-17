#include <DHT.h>
#define motor1A 5
#define motor2A 16
#define DHTPIN 17
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  pinMode(motor1A, OUTPUT);
  pinMode(motor2A, OUTPUT);
  dht.begin();

}

void loop() {
  delay(1000);
  float temperature = dht.readTemperature();
  if (isnan(temperature)){
    Serial.println("DHT sensor is fucked!!");
    return;
  }
  else {
    Serial.print("Temperature: ");
    Serial.println(temperature);
    if(temperature<10){
      analogWrite(motor1A, 0);
      analogWrite(motor2A, 0);
    }
    else if(temperature>10 && temperature<12){
      analogWrite(motor1A, 136);
      analogWrite(motor2A, 0);
    }
    else if(temperature > 12){
      analogWrite(motor1A, 255);
      analogWrite(motor2A, 0);
    }
  }

}
