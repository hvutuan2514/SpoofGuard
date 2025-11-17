#implementation of SeFACED
import pandas as pd
import spacy
import string
import re
import json
import tensorflow as tf
import gensim
from gensim.models import Word2Vec
import numpy as np
from nltk.corpus import stopwords
from tensorflow.keras.preprocessing.text import Tokenizer
from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint
from keras.preprocessing.sequence import pad_sequences
from keras.models import Sequential
from keras.utils import to_categorical
from keras.layers import Dense, Embedding,LSTM, Dropout, GRU, Bidirectional
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import normalize
from sklearn.naive_bayes import MultinomialNB
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder
from sklearn.svm import SVC
from sklearn.metrics import accuracy_score
from sklearn.feature_extraction.text import TfidfVectorizer, CountVectorizer
from sklearn.utils.class_weight import compute_class_weight

# !pip install gensim
# !pip install --upgrade gensim
# !wget http://nlp.stanford.edu/data/glove.6B.zip
# !unzip glove.6B.zip

#for runtime
import time
start = time.time()

#input data from excel file
df = pd.read_excel("/content/SEFACED_Email_Forensic_Dataset.xlsx")

#For testing purposes
print(df.head())



###Data Pre-processing###

#nltk.download('stopwords')
import nltk
nltk.download('stopwords')
nltk.download('punkt')
nltk.download('wordnet')

stop_words = set(stopwords.words('english'))
punctuation = set(string.punctuation)

#Create copy for cleaned data
df_cleaned = df.copy()

#only cleaning "text" column
text_column = 'Text'
#Tokenization using SpaCy library
nlp = spacy.load('en_core_web_sm')
stop_words = set(stopwords.words('english'))
cleaned = []
text_data = df_cleaned[text_column].astype(str).tolist()

def clean_text(text):
    if pd.isna(text):
        return ""
    #Lowercase and remove empty tokens
    text = str(text).lower()
    #Remove email tags
    text = re.sub(r'http\S+', ' ', text)
    text = re.sub(r'www\S+', ' ', text)
    text = re.sub(r'\S+@\S+', ' ', text)
    #Remove Forward and Hyperlinks
    text = re.sub(r'\b(Re|Fwd|FW|forwarded|cc|To|From|Subject)\b', ' ', text, flags=re.IGNORECASE)
    #Remove numbers
    text = re.sub(r'\d+', ' ', text)
    #Remove whitespace and tab
    text = re.sub(r'\s+', ' ', text)
    #Remove symbols
    text = re.sub(r'[^a-z\s]', ' ', text)
    #Remove stopwords
    tokens = [t for t in text.split() if t not in stop_words and len(t) > 2]
    return " ".join(tokens)

df_cleaned['cleaned_text'] = df_cleaned['Text'].apply(clean_text)
print(df_cleaned[['Text', 'cleaned_text']].head())

###SPLIT 65% TRAINING TESTING 25% VALIDATION 10%###
text_column = 'cleaned_text'
target_column = 'Class_Label'
class_labels = df_cleaned['Class_Label'].values

#split
y = df_cleaned[target_column].values
X_temp, X_test, y_temp, y_test = train_test_split(
    df_cleaned['cleaned_text'], y, test_size=0.25, random_state=42, stratify=class_labels
)
fraction = 0.10 / 0.75  # Adjusted fraction for validation set
X_train, X_val, y_train, y_val = train_test_split(
    X_temp, y_temp, test_size=fraction, random_state=42,stratify=y_temp
)



###Feature Extraction###
X_text = df_cleaned['cleaned_text']
#TF-IDF
tfidf = TfidfVectorizer()
X_train_tfidf = tfidf.fit_transform(X_train)
X_val_tfidf = tfidf.transform(X_val)
X_test_tfidf = tfidf.transform(X_test)


#Bag of Words
vector = CountVectorizer()
bag_of_words = vector.fit_transform(X_text)
words = vector.get_feature_names_out()
word_counts = bag_of_words.toarray().sum(axis=0)

#Word2vector
tokenized_text = [text.split() for text in X_text]
word2vec_cbow_model = gensim.models.Word2Vec(sentences=tokenized_text, min_count=1, vector_size=100, window=5)
word2vec_sg_model = gensim.models.Word2Vec(sentences=tokenized_text, min_count=1, window=5, sg=1)



label_encoder = LabelEncoder()
y_train_le = label_encoder.fit_transform(y_train)
y_val_le = label_encoder.transform(y_val)
y_test_le = label_encoder.transform(y_test)




###Machine Learning Models to compare###

# #Logistic  Regression
# lr_model = LogisticRegression()
# lr_model.fit(X_train_tfidf, y_train_le)
# # Evaluate the model's accuracy
# y_pred = lr_model.predict(X_test_tfidf)
# accuracy = accuracy_score(y_test_le, y_pred)
# print(f"Accuracy of Logistic Regression: {accuracy:.2f}")

# #Support Vector Machine
# svm_model = SVC(kernel='linear')
# svm_model.fit(X_train_tfidf, y_train_le)
# # Evaluate the model's accuracy
# y_pred = svm_model.predict(X_test_tfidf)
# accuracy = accuracy_score(y_test_le, y_pred)
# print(f"Accuracy of SVM: {accuracy:.2f}")

# #Stochastic Gradient Descent


# #Naive Bayes
# nb_model = MultinomialNB()
# nb_model.fit(X_train_tfidf, y_train_le)
# # Evaluate the model's accuracy
# y_pred = nb_model.predict(X_test_tfidf)
# accuracy = accuracy_score(y_test_le, y_pred)
# print(f"Accuracy of Naive Bayes: {accuracy:.2f}")

# #Random Forest
# rf_model = RandomForestClassifier()
# rf_model.fit(X_train_tfidf, y_train_le)
# # Evaluate the model's accuracy
# y_pred = rf_model.predict(X_test_tfidf)
# accuracy = accuracy_score(y_test_le, y_pred)
# print(f"Accuracy of Random Forest: {accuracy:.2f}")


#parameters defined in paper
vocab_size = 70000
embedding_dim = 300
max_length = 600

tokenizer = Tokenizer(oov_token="<OOV>", filters="")
tokenizer.fit_on_texts(X_train)


def padded_length(sequences, maxlen):
    seq = tokenizer.texts_to_sequences(sequences)
    return pad_sequences(seq, maxlen=maxlen, padding="post")

X_train_seq = tokenizer.texts_to_sequences(X_train)
X_val_seq = tokenizer.texts_to_sequences(X_val)
X_test_seq = tokenizer.texts_to_sequences(X_test)

X_train_pad = pad_sequences(X_train_seq, maxlen=max_length, padding="post")
X_val_pad = pad_sequences(X_val_seq, maxlen=max_length, padding="post")
X_test_pad = pad_sequences(X_test_seq, maxlen=max_length, padding="post")

num_classes = len(label_encoder.classes_)
y_train_cat = tf.keras.utils.to_categorical(y_train_le, num_classes)
y_val_cat = tf.keras.utils.to_categorical(y_val_le, num_classes)
y_test_cat = tf.keras.utils.to_categorical(y_test_le, num_classes)

#for embedding matrix

embedding_index = {}

with open('glove.6B.300d.txt', encoding='utf8') as f:
  for line in f:
    values = line.split()
    word = values[0]
    coeffs = np.asarray(values[1:], dtype='float32')
    embedding_index[word] = coeffs

embedding_matrix = np.zeros((vocab_size, embedding_dim))

for word, i in tokenizer.word_index.items():
  if i < vocab_size:
    vector = embedding_index.get(word)
    if vector is not None:
      embedding_matrix[i] = vector
      

#LSTM-GRU Model architecture
model = Sequential([
    Embedding(input_dim=vocab_size, output_dim=embedding_dim, weights= [embedding_matrix], input_length=max_length, trainable=False),
    #LSTM layer 1
    Bidirectional(LSTM(250, return_sequences=True)),
    #GRU layer
    Bidirectional(GRU(250, return_sequences=False)),
])
#Internal Dense Layers with Dropout
for _ in range(1):
    model.add(Dense(64, activation='relu'))
    model.add(Dropout(0.5))

#Output Layer
model.add(Dense(4, activation='softmax'))

#Compile the model
model.compile(optimizer='adam', loss='categorical_crossentropy', metrics=['accuracy'])
model.build(input_shape=(None, max_length))
model.summary()
print("LSTM-GRU Model Compiled")
#Train the model
checkpoint = ModelCheckpoint('best_model.keras', monitor='val_accuracy', save_best_only=True, mode='max', verbose=1)
earlystopping = EarlyStopping(monitor='val_accuracy', patience=3, restore_best_weights=True)
history = model.fit(
    X_train_pad, y_train_cat,
    validation_data=(X_val_pad, y_val_cat),
    epochs=20,
    batch_size=64,
    callbacks=[earlystopping],
    # class_weight=class_weights,
    verbose=1
)
#Evaluate the model
loss, accuracy = model.evaluate(X_test_pad, y_test_cat)
print(f'Test Accuracy: {accuracy:.2f}')



#Save model and tokenizer
import pickle
with open('tokenizer.pickle', 'wb') as handle:
    pickle.dump(tokenizer, handle)
meta = {
    'label_classes': list(label_encoder.classes_),
    'maxlen': max_length,
    'vocab_size': vocab_size,
    'embedding_dim': embedding_dim
}
with open('meta.json', 'w') as handle:
    json.dump(meta, handle)
model.save('sefacd_email_model.keras')




end_time = time.time()
print(f"Execution took {end_time - start} seconds")
