#define motor1A 5
#define motor2A 16

const int buttonStop = 17;    // Stop button pin
const int buttonMedium = 18;  // Low speed (70%) button
const int buttonFull = 19;    // Full speed (100%) button

int fanSpeed = 0;     // Current fan speed (0–255)
int lastSpeed = -1;   // Store previous speed to prevent redundant writes

void setup() {
  Serial.begin(115200);

  pinMode(motor1A, OUTPUT);
  pinMode(motor2A, OUTPUT);

  pinMode(buttonStop, INPUT);    // Button: use external pull-up
  pinMode(buttonMedium, INPUT);
  pinMode(buttonFull, INPUT);

  analogWrite(motor1A, 0);  // Fan initially off
  analogWrite(motor2A, 0);  // Reverse direction pin off
}

void loop() {
  // Check if STOP button is pressed
  if (digitalRead(buttonStop) == LOW) {
    delay(200); // Debounce
    while(digitalRead(buttonStop) == LOW);
      fanSpeed = 0;
  }
  // Else check if MEDIUM button is pressed
  else if (digitalRead(buttonMedium) == LOW) {
    delay(200); // Debounce
    while(digitalRead(buttonMedium) == LOW);
      fanSpeed = 179; // ~70%
  }
  // Else check if FULL button is pressed
  else if (digitalRead(buttonFull) == LOW) {
    delay(50); // Debounce
    while(digitalRead(buttonFull) == LOW)
      fanSpeed = 255; // 100%
  }

  // Only update motor if speed changed
  if (fanSpeed != lastSpeed) {
    analogWrite(motor1A, fanSpeed);
    analogWrite(motor2A, 0); // Always forward
    Serial.print("Fan speed set to: ");
    Serial.print(fanSpeed);
    Serial.println("/255");
    lastSpeed = fanSpeed;
  }

  delay(100); // Short loop delay
}
